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

function subscribeBrain(connection) {
  const brain = connection.get('ot_brain', NUCLINO_BRAIN_ID);

  brain.subscribe();
  brain.on('load', () => {
    brain.data.cells.forEach(cell => subscribeCell(connection, cell));
    console.log(`subscribet to ${brain.data.cells.length} cells`);
  });

  brain.on('op', () => {
    brain.data.cells.forEach((name, i) => {
      if (!cells[name]) {
        subscribeCell(connection, name, cell => {
          console.log(`Page created ${cell.data.title}`);
        });
      }
    });
  });
}

const cells = {};
function subscribeCell(connection, name, cb) {
  const cell = connection.get('ot_cell', name);
  cell.subscribe();
  cells[name] = cell;
  cell.on('op', () => triggerUpdate(cell));
  if (typeof cb === 'function') {
    cell.on('load', () => cb(cell));
  }
}

const timers = {};
function triggerUpdate(cell) {
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
