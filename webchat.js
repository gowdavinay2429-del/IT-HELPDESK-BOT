/*
webchat.js
A self-contained, framework-free web chat widget for Rasa (REST or SocketIO).

Usage:
1. Include in your HTML:
   <script type="module" src="/path/to/webchat.js"></script>

2. Initialize:
   import WebChat from '/path/to/webchat.js';
   const chat = new WebChat({
     rasaEndpoint: '/webhooks/rest/webhook', // or set transport: 'socket' with socketUrl
     transport: 'rest', // 'rest' or 'socket'
     container: document.getElementById('chat-root'),
     title: 'Support',
     subtitle: 'How can I help?',
     showTimestamps: false,
     storageKey: 'rasa_chat_session',
     sessionTimeout: 60*60*1000, // 1 hour
     jwt: null, // optional Authorization Bearer token
     reconnectInterval: 5000,
   });
   chat.open();

Features:
- REST or Socket (Socket.IO) transport (socket transport expects Socket.IO to be available globally as `io`).
- Quick replies (buttons), images, attachments, custom payload handling.
- Typing indicator and message status.
- Local session storage; persists sender id.
- Minimal CSS included (scoped inside script); can override with your own styles.

Note: For Socket transport, include socket.io client in your page:
<script src="https://cdn.socket.io/4.5.0/socket.io.min.js"></script>

*/

export default class WebChat {
  constructor(opts = {}) {
    // default options
    const defaults = {
      transport: 'rest', // 'rest' or 'socket'
      rasaEndpoint: '/webhooks/rest/webhook',
      initPayload: null, // <-- ADD THIS LINE
      socketUrl: null, // e.g. 'https://chat.example.com'
      container: null, // DOM node or selector
      title: 'Chat',
      subtitle: '',
      placeholder: 'Type a message...',
      showTimestamps: false,
      storageKey: 'rasa_webchat',
      sessionTimeout: 1000 * 60 * 60, // 1 hour
      jwt: null, // optional Bearer token for auth
      reconnectInterval: 5000,
      user: {id: null, name: 'You'},
      botName: 'Bot',
      botAvatar: null,
      userAvatar: null,
      theme: {
        primary: '#0066ff',
        accent: '#ffffff',
        userBubble: '#e6f0ff',
        botBubble: '#f5f5f5',
      }
    };

    this.opts = Object.assign({}, defaults, opts);
    this.container = this._resolveContainer(this.opts.container);
    if (!this.container) throw new Error('Container element required');

    this.session = this._loadSession();
    this.socket = null;
    this.typingTimeout = null;
    this.reconnectTimer = null;

    this._renderUI();
    this._bindUI();

    if (this.opts.transport === 'socket') this._initSocket();
    if (this.opts.initPayload) {
            this._sendUserMessage(this.opts.initPayload, true);
    }
  }

  /*************** Initialization & session ***************/
  _resolveContainer(container) {
    if (!container) return null;
    if (typeof container === 'string') return document.querySelector(container);
    return container;
  }

  _loadSession() {
    try {
      const data = localStorage.getItem(this.opts.storageKey);
      if (!data) return this._createSession();
      const parsed = JSON.parse(data);
      const now = Date.now();
      if (now - parsed.timestamp > this.opts.sessionTimeout) {
        return this._createSession();
      }
      return parsed;
    } catch (e) {
      return this._createSession();
    }
  }

  _createSession() {
    const sess = {
      sender_id: this.opts.user.id || `user_${Math.random().toString(36).slice(2,10)}`,
      timestamp: Date.now()
    };
    localStorage.setItem(this.opts.storageKey, JSON.stringify(sess));
    return sess;
  }

  _saveSession() {
    this.session.timestamp = Date.now();
    localStorage.setItem(this.opts.storageKey, JSON.stringify(this.session));
  }

  /*************** UI Rendering ***************/
  _renderUI() {
    // inject stylesheet
    if (!document.getElementById('rasa-webchat-styles')) this._injectStyles();

    // create main structure
    this.root = document.createElement('div');
    this.root.className = 'rasa-webchat-root';

    // header
    this.header = document.createElement('div');
    this.header.className = 'rasa-webchat-header';
    this.header.innerHTML = `
      <div class="rasa-webchat-title">${this.opts.title}</div>
      <div class="rasa-webchat-subtitle">${this.opts.subtitle || ''}</div>
      <button class="rasa-webchat-toggle" aria-label="Close">×</button>
    `;

    // content area
    this.content = document.createElement('div');
    this.content.className = 'rasa-webchat-content';

    // messages
    this.messages = document.createElement('div');
    this.messages.className = 'rasa-webchat-messages';

    // input bar
    this.inputBar = document.createElement('form');
    this.inputBar.className = 'rasa-webchat-inputbar';
    this.inputBar.innerHTML = `
      <input type="text" class="rasa-webchat-input" placeholder="${this.opts.placeholder}" autocomplete="off"/>
      <button class="rasa-webchat-send" aria-label="Send">Send</button>
    `;

    // assemble
    this.content.appendChild(this.messages);
    this.content.appendChild(this.inputBar);
    this.root.appendChild(this.header);
    this.root.appendChild(this.content);

    // mount
    this.container.appendChild(this.root);

    // references
    this.inputField = this.inputBar.querySelector('.rasa-webchat-input');
    this.sendButton = this.inputBar.querySelector('.rasa-webchat-send');
    this.toggleButton = this.header.querySelector('.rasa-webchat-toggle');
  }

  _injectStyles() {
    const css = `
.rasa-webchat-root{font-family:Arial,Helvetica,sans-serif; width:320px; max-width:90vw; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.12); overflow:hidden; background:white}
.rasa-webchat-header{background:${this.opts.theme.primary}; color:${this.opts.theme.accent}; padding:12px; display:flex; align-items:center; justify-content:space-between}
.rasa-webchat-title{font-weight:700}
.rasa-webchat-subtitle{font-size:12px; opacity:0.9}
.rasa-webchat-toggle{background:transparent;border:0;color:inherit;font-size:20px;cursor:pointer}
.rasa-webchat-content{display:flex;flex-direction:column; height:420px}
.rasa-webchat-messages{flex:1; overflow:auto; padding:12px; background:#fafafa}
.rasa-msg{margin:8px 0; max-width:85%; display:flex}
.rasa-msg.bot{justify-content:flex-start}
.rasa-msg.user{justify-content:flex-end}
.rasa-msg .bubble{padding:10px 12px; border-radius:12px; line-height:1.3}
.rasa-msg.bot .bubble{background:${this.opts.theme.botBubble}; color:#111}
.rasa-msg.user .bubble{background:${this.opts.theme.userBubble}; color:#111}
.rasa-msg .meta{font-size:10px; opacity:0.6; margin-top:4px}
.rasa-webchat-inputbar{display:flex; padding:8px; border-top:1px solid #eee}
.rasa-webchat-input{flex:1; padding:8px 10px; border-radius:6px; border:1px solid #ddd}
.rasa-webchat-send{margin-left:8px; padding:8px 12px; border-radius:6px; border:0; background:${this.opts.theme.primary}; color:${this.opts.theme.accent}; cursor:pointer}
.rasa-quickreplies{display:flex; gap:8px; flex-wrap:wrap; margin-top:8px}
.rasa-quickreplies button{border:0;padding:6px 8px;border-radius:18px;background:#fff;cursor:pointer;border:1px solid #ddd}
.rasa-typing{font-style:italic; opacity:0.75}
.rasa-img{max-width:200px;border-radius:8px}
`;
    const style = document.createElement('style');
    style.id = 'rasa-webchat-styles';
    style.innerHTML = css;
    document.head.appendChild(style);
  }

  /*************** UI binding ***************/
  _bindUI() {
    // toggle
    this.toggleButton.addEventListener('click', () => this.close());

    // send on submit
    this.inputBar.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.inputField.value.trim();
      if (!text) return;
      this._sendUserMessage(text);
      this.inputField.value = '';
    });

    // send button
    this.sendButton.addEventListener('click', (e) => {
      e.preventDefault();
      const text = this.inputField.value.trim();
      if (!text) return;
      this._sendUserMessage(text);
      this.inputField.value = '';
    });

    // click on quickreply buttons (event delegation)
    this.messages.addEventListener('click', (e) => {
      const btn = e.target.closest('.rasa-quick-btn');
      if (btn) {
        const payload = btn.dataset.payload || btn.textContent;
        this._sendUserMessage(payload);
      }
    });
  }

  /*************** Public API ***************/
  open() { this.root.style.display = 'block'; }
  close() { this.root.style.display = 'none'; }
  destroy() { this.container.removeChild(this.root); }

  sendCustom(payload) {
    // useful to programmatically send custom JSON payloads
    if (this.opts.transport === 'socket') this._sendSocket(payload);
    else this._sendRest(payload);
  }

  /*************** Message renderers ***************/
  _renderMessage({text=null, from='bot', metadata=null, image=null, buttons=null, custom=null, ts=null}){
    const wrapper = document.createElement('div');
    wrapper.className = `rasa-msg ${from === 'user' ? 'user' : 'bot'}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (image) {
      const img = document.createElement('img');
      img.className = 'rasa-img';
      img.src = image;
      bubble.appendChild(img);
    }

    if (text) {
      const p = document.createElement('div');
      p.innerHTML = this._escapeHtml(text).replace(/\n/g, '<br/>');
      bubble.appendChild(p);
    }

    if (custom) {
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.marginTop = '8px';
      pre.textContent = JSON.stringify(custom, null, 2);
      bubble.appendChild(pre);
    }

    wrapper.appendChild(bubble);

    // meta
    if (this.opts.showTimestamps && ts) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = new Date(ts).toLocaleTimeString();
      wrapper.appendChild(meta);
    }

    this.messages.appendChild(wrapper);
    this._scrollToBottom();

    // render buttons (quick replies) below the message
    if (buttons && buttons.length) {
      const qr = document.createElement('div');
      qr.className = 'rasa-quickreplies';
      buttons.forEach(b => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rasa-quick-btn';
        btn.dataset.payload = b.payload || b.title || b;
        btn.textContent = b.title || b;
        qr.appendChild(btn);
      });
      this.messages.appendChild(qr);
      this._scrollToBottom();
    }
  }

  _renderTyping() {
    if (this.typingEl) return; // already showing
    this.typingEl = document.createElement('div');
    this.typingEl.className = 'rasa-msg bot';
    this.typingEl.innerHTML = `<div class="bubble rasa-typing">${this._escapeHtml(this.opts.botName)} is typing...</div>`;
    this.messages.appendChild(this.typingEl);
    this._scrollToBottom();
  }

  _removeTyping() {
    if (this.typingEl) { this.typingEl.remove(); this.typingEl = null; }
  }

  _scrollToBottom() {
    this.messages.scrollTop = this.messages.scrollHeight + 200;
  }

  /*************** Sending messages ***************/
  _sendUserMessage(text, isSilent = false) {
    // render user message immediately
    if (!isSilent) { // <-- Only render if it's not a silent message
      this._renderMessage({text, from: 'user', ts: Date.now()});
    }
    const payload = { sender: this.session.sender_id, message: text };
    if (this.opts.transport === 'socket') this._sendSocket({type:'user', payload});
    else this._sendRest(payload);
  }

  _sendRest(payload) {
    this._renderTyping();
    const headers = {'Content-Type':'application/json'};
    if (this.opts.jwt) headers['Authorization'] = `Bearer ${this.opts.jwt}`;

    fetch(this.opts.rasaEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({sender: this.session.sender_id, message: payload.message || ''})
    }).then(r => r.json()).then(data => {
      this._removeTyping();
      if (!Array.isArray(data)) return;
      data.forEach(msg => this._handleRasaMessage(msg));
      this._saveSession();
    }).catch(err => {
      this._removeTyping();
      this._renderMessage({text:'Error: Could not reach server.', from:'bot'});
      console.error('Rasa REST error', err);
      this._saveSession();
    });
  }

  _initSocket() {
    if (typeof io === 'undefined') {
      console.warn('Socket.IO client not found. Include socket.io client or use REST transport.');
      return;
    }

    const url = this.opts.socketUrl || window.location.origin;
    this.socket = io(url, {autoConnect:false});

    this.socket.on('connect', () => {
      console.log('socket connected');
      // perform handshake if Rasa socket expects 'session_request' or similar
      this.socket.emit('session_request', {session_id: this.session.sender_id});
    });

    this.socket.on('bot_uttered', (msg) => {
      // rasa_socketio uses 'bot_uttered' events for messages
      this._removeTyping();
      this._handleRasaMessage(msg);
    });

    this.socket.on('typing', () => this._renderTyping());
    this.socket.on('connect_error', () => this._scheduleReconnect());
    this.socket.on('disconnect', () => this._scheduleReconnect());

    this.socket.connect();
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return; // already scheduled
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket && !this.socket.connected) this.socket.connect();
    }, this.opts.reconnectInterval);
  }

  _sendSocket(data) {
    if (!this.socket || !this.socket.connected) {
      this._renderMessage({text:'Not connected. Trying to reconnect...', from:'bot'});
      this._scheduleReconnect();
      return;
    }
    // determine event name -- many Rasa socket setups use 'user_uttered'
    const event = data.type === 'user' ? 'user_uttered' : 'user_message';
    this.socket.emit(event, {
      message: data.payload.message,
      sender: this.session.sender_id,
      ...data.payload
    });
  }

  /*************** Incoming message handler ***************/
  _handleRasaMessage(msg) {
    /* Expected shapes:
       - { text: 'hi' }
       - { image: 'https://...' }
       - { buttons: [{title, payload}], text: 'choose' }
       - { custom: { ... } }
    */
    if (!msg) return;

    // bot might send multiple fields
    const text = msg.text || (msg.message && msg.message.text) || null;
    const image = msg.image || (msg.attachment && msg.attachment.payload && msg.attachment.payload.src) || null;
    const buttons = msg.buttons || (msg.payload && msg.payload.buttons) || null;
    const custom = msg.custom || (msg.payload && msg.payload.custom) || null;

    // if msg may contain quick replies in custom payload {quick_replies:[..]}
    if (msg.quick_replies) {
      return this._renderMessage({text: msg.text || 'Choose:', from:'bot', buttons: msg.quick_replies});
    }

    // typical rasa mapper
    if (text || image || buttons || custom) {
      this._renderMessage({text, image, buttons, custom, from:'bot', ts:Date.now()});
      return;
    }

    // fallback: render raw
    this._renderMessage({text: JSON.stringify(msg), from:'bot', custom:msg});
  }

  /*************** Utilities ***************/
  _escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// If loaded as non-module script (fallback), attach to window
if (typeof window !== 'undefined' && !window.WebChat) {
  window.WebChat = WebChat;
}
