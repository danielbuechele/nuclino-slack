const WebSocket = require('ws');
const fetch = require('node-fetch');
const fs = require('fs');
const ShareDB = require('@danielbuechele/sharedb/lib/client');
const {
  TOKEN_PATH,
  SLACK_WEBHOOK,
  NUCLINO_APP_ID,
  NUCLINO_BRAIN_ID,
  NUCLINO_TEAM,
} = require('./config.js');

function getHeaders(token) {
  return {
    Cookie: `_ga=GA1.2.2136818352.1517691405; _gid=GA1.2.1271612510.1517691405; app-uid=${NUCLINO_APP_ID}; tr_p7tlufngy5={"referrer":"","query":"","variant":"production"}; token=${token}`,
    Origin: 'https://app.nuclino.com',
  };
}

function createBackup(token) {
  console.log('Create backup');
  fetch(
    `https://files.nuclino.com/export/brains/${NUCLINO_BRAIN_ID}.zip?format=md`,
    {
      method: 'GET',
      headers: getHeaders(token),
    }
  ).then(res => {
    console.log(`downloaded backup`);
    const fileStream = fs.createWriteStream('./backup.zip');
    res.body.pipe(fileStream);
  });
}

function updateToken() {
  const oldToken = fs
    .readFileSync(TOKEN_PATH)
    .toString()
    .trim();

  return fetch('https://api.nuclino.com/api/users/me/refresh-session', {
    method: 'POST',
    headers: {...getHeaders(oldToken), 'X-Requested-With': 'XMLHttpRequest'},
  })
    .then(res => res.headers.get('Set-Cookie'))
    .then(cookie => {
      const match = cookie.match(/token=([A-Za-z0-9+-\._]+)/);
      if (match && match.length > 0) {
        token = match[1];
        fs.writeFile(TOKEN_PATH, token, 'utf8');
      }
      return token;
    });
}

const visited = new Set();
function traverseTree(connection, id) {
  if (visited.has(id)) {
    return;
  }
  visited.add(id);
  subscribeCell(connection, id, cell => {
    cell.data.childIds.map(id => traverseTree(connection, id));
  });
}

function subscribeBrain(connection) {
  const brain = connection.get('ot_brain', NUCLINO_BRAIN_ID);

  brain.subscribe();
  brain.on('load', () => {
    console.log(brain.data.mainCellId);
    traverseTree(connection, brain.data.mainCellId);
  });
}

const cells = {};
function subscribeCell(connection, name, cb) {
  console.log('subscribe ' + name);
  const cell = connection.get('ot_cell', name);
  cell.subscribe();
  cells[name] = cell;
  cell.on('op', () => triggerUpdate(connection, cell));
  if (typeof cb === 'function') {
    cell.on('load', () => cb(cell));
  }
}

const timers = {};
function triggerUpdate(connection, cell) {
  // check for new cells
  for (let i = 0; i < cell.data.childIds.length; i++) {
    if (!visited.has(cell.data.childIds[i])) {
      console.log(`new page created ${cell.id}`);
      subscribeCell(connection, cell.data.childIds[i]);
      return;
    }
  }

  console.log(`updated cell ${cell.id}`);
  if (timers[cell.id]) {
    clearTimeout(timers[cell.id]);
  }
  timers[cell.id] = setTimeout(() => {
    fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        text: `<https://app.nuclino.com/${NUCLINO_TEAM}/General/${cell.id}|${
          cell.data.title
        }> wurde aktualisiert`,
      }),
    });
  }, 2 * 60 * 1000);
}

let killProcess = null;
async function startWatching() {
  const token = await updateToken();

  createBackup(token);

  const socket = new WebSocket('wss://api.nuclino.com/syncing', {
    headers: getHeaders(token),
  });

  const connection = new ShareDB.Connection(socket);
  connection.on('state', state => {
    console.log(`new connection state: ${state}`);
    if (state === 'connected') {
      subscribeBrain(connection);
    } else if (state === 'disconnected') {
      startWatching();
    }
  });

  // restart every day to renew token
  if (!killProcess) {
    killProcess = setTimeout(() => process.exit(1), 24 * 60 * 60 * 1000);
  }
}

startWatching();
