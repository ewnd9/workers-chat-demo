let currentWebSocket = null;

const nameForm = document.querySelector<HTMLFormElement>('#name-form');
const nameInput = document.querySelector<HTMLInputElement>('#name-input');
const roomForm = document.querySelector<HTMLInputElement>('#room-form');
const roomNameInput = document.querySelector<HTMLInputElement>('#room-name');
const goPublicButton = document.querySelector<HTMLButtonElement>('#go-public');
const goPrivateButton =
  document.querySelector<HTMLButtonElement>('#go-private');
const chatroom = document.querySelector<HTMLInputElement>('#chatroom');
const chatlog = document.querySelector<HTMLInputElement>('#chatlog');
const chatInput = document.querySelector<HTMLInputElement>('#chat-input');
const roster = document.querySelector<HTMLInputElement>('#roster');

let isAtBottom = true;

let username: string;
let roomname: string;

let hostname = window.location.host;
if (hostname == '') {
  // Probably testing the HTML locally.
  hostname = 'edge-chat-demo.cloudflareworkers.com';
}

startNameChooser();

function startNameChooser() {
  nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    username = nameInput.value;
    if (username.length > 0) {
      startRoomChooser();
    }
  });

  nameInput.addEventListener('input', (event) => {
    const target = event.currentTarget as HTMLInputElement;
    if (target.value.length > 32) {
      target.value = target.value.slice(0, 32);
    }
  });

  nameInput.focus();
}

function startRoomChooser() {
  nameForm.remove();

  if (document.location.hash.length > 1) {
    roomname = document.location.hash.slice(1);
    startChat();
    return;
  }

  roomForm.addEventListener('submit', (event) => {
    event.preventDefault();
    roomname = roomNameInput.value;
    if (roomname.length > 0) {
      startChat();
    }
  });

  roomNameInput.addEventListener('input', (event) => {
    const target = event.currentTarget as HTMLInputElement;
    if (target.value.length > 32) {
      target.value = target.value.slice(0, 32);
    }
  });

  goPublicButton.addEventListener('click', (event) => {
    roomname = roomNameInput.value;
    if (roomname.length > 0) {
      startChat();
    }
  });

  goPrivateButton.addEventListener('click', async (event) => {
    roomNameInput.disabled = true;
    goPublicButton.disabled = true;
    const target = event.currentTarget as HTMLButtonElement;
    target.disabled = true;

    const response = await fetch('https://' + hostname + '/api/room', {
      method: 'POST',
    });
    if (!response.ok) {
      alert('something went wrong');
      document.location.reload();
      return;
    }

    roomname = await response.text();
    startChat();
  });

  roomNameInput.focus();
}

function startChat() {
  roomForm.remove();

  // Normalize the room name a bit.
  roomname = roomname
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .replace(/_/g, '-')
    .toLowerCase();

  if (roomname.length > 32 && !roomname.match(/^[0-9a-f]{64}$/)) {
    addChatMessage('ERROR', 'Invalid room name.');
    return;
  }

  document.location.hash = '#' + roomname;

  chatInput.addEventListener('keydown', (event) => {
    if (event.keyCode == 38) {
      // up arrow
      chatlog.scrollBy(0, -50);
    } else if (event.keyCode == 40) {
      // down arrow
      chatlog.scrollBy(0, 50);
    } else if (event.keyCode == 33) {
      // page up
      chatlog.scrollBy(0, -chatlog.clientHeight + 50);
    } else if (event.keyCode == 34) {
      // page down
      chatlog.scrollBy(0, chatlog.clientHeight - 50);
    }
  });

  chatroom.addEventListener('submit', (event) => {
    event.preventDefault();

    if (currentWebSocket) {
      currentWebSocket.send(JSON.stringify({ message: chatInput.value }));
      chatInput.value = '';

      // Scroll to bottom whenever sending a message.
      chatlog.scrollBy(0, 1e8);
    }
  });

  chatInput.addEventListener('input', (event) => {
    const target = event.currentTarget as HTMLInputElement;
    if (target.value.length > 256) {
      target.value = target.value.slice(0, 256);
    }
  });

  chatlog.addEventListener('scroll', (event) => {
    isAtBottom =
      chatlog.scrollTop + chatlog.clientHeight >= chatlog.scrollHeight;
  });

  chatInput.focus();
  document.body.addEventListener('click', (event) => {
    // If the user clicked somewhere in the window without selecting any text, focus the chat
    // input.
    if (window.getSelection().toString() == '') {
      chatInput.focus();
    }
  });

  // Detect mobile keyboard appearing and disappearing, and adjust the scroll as appropriate.
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', function (event) {
      if (isAtBottom) {
        chatlog.scrollBy(0, 1e8);
      }
    });
  }

  join();
}

let lastSeenTimestamp = 0;
let wroteWelcomeMessages = false;

function join() {
  let ws = new WebSocket(
    (location.protocol === 'http:' ? 'ws://' : 'wss://') +
      hostname +
      '/api/room/' +
      roomname +
      '/websocket'
  );
  let rejoined = false;
  let startTime = Date.now();

  let rejoin = async () => {
    if (!rejoined) {
      rejoined = true;
      currentWebSocket = null;

      // Clear the roster.
      while (roster.firstChild) {
        roster.removeChild(roster.firstChild);
      }

      // Don't try to reconnect too rapidly.
      let timeSinceLastJoin = Date.now() - startTime;
      if (timeSinceLastJoin < 10000) {
        // Less than 10 seconds elapsed since last join. Pause a bit.
        await new Promise((resolve) =>
          setTimeout(resolve, 10000 - timeSinceLastJoin)
        );
      }

      // OK, reconnect now!
      join();
    }
  };

  ws.addEventListener('open', (_event) => {
    currentWebSocket = ws;
    ws.send(JSON.stringify({ name: username }));
  });

  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      addChatMessage(null, '* Error: ' + data.error);
    } else if (data.joined) {
      let p = document.createElement('p');
      p.innerText = data.joined;
      roster.appendChild(p);
    } else if (data.quit) {
      for (let child of roster.childNodes) {
        // unclear
        // @ts-expect-error
        if (child.innerText == data.quit) {
          roster.removeChild(child);
          break;
        }
      }
    } else if (data.ready) {
      // All pre-join messages have been delivered.
      if (!wroteWelcomeMessages) {
        wroteWelcomeMessages = true;
        addChatMessage(
          null,
          '* This is a demo app built with Cloudflare Workers Durable Objects. The source code ' +
            'can be found at: https://github.com/cloudflare/workers-chat-demo'
        );
        addChatMessage(
          null,
          '* WARNING: Participants in this chat are random people on the internet. ' +
            'Names are not authenticated; anyone can pretend to be anyone. The people ' +
            'you are chatting with are NOT Cloudflare employees. Chat history is saved.'
        );
        if (roomname.length == 64) {
          addChatMessage(
            null,
            '* This is a private room. You can invite someone to the room by sending them the URL.'
          );
        } else {
          addChatMessage(null, '* Welcome to #' + roomname + '. Say hi!');
        }
      }
    } else {
      // A regular chat message.
      if (data.timestamp > lastSeenTimestamp) {
        addChatMessage(data.name, data.message);
        lastSeenTimestamp = data.timestamp;
      }
    }
  });

  ws.addEventListener('close', (event) => {
    console.log('WebSocket closed, reconnecting:', event.code, event.reason);
    rejoin();
  });
  ws.addEventListener('error', (event) => {
    console.log('WebSocket error, reconnecting:', event);
    rejoin();
  });
}

function addChatMessage(name, text) {
  const p = document.createElement('p');
  if (name) {
    const tag = document.createElement('span');
    tag.className = 'username';
    tag.innerText = name + ': ';
    p.appendChild(tag);
  }
  p.appendChild(document.createTextNode(text));

  chatlog.appendChild(p);
  if (isAtBottom) {
    chatlog.scrollBy(0, 1e8);
  }
}
