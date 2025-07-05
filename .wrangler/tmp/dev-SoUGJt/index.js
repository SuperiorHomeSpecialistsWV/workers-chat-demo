var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-a7fhwL/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// src/chat-room.js
var ChatRoom = class {
  static {
    __name(this, "ChatRoom");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
    this.users = /* @__PURE__ */ new Map();
    this.buddyLists = /* @__PURE__ */ new Map();
    this.awayMessages = /* @__PURE__ */ new Map();
    this.warningLevels = /* @__PURE__ */ new Map();
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/users") {
      return this.handleUserStorage(request);
    }
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.handleSession(server, request);
    return new Response(null, {
      status: 101,
      // @ts-ignore
      webSocket: client
    });
  }
  async handleUserStorage(request) {
    try {
      if (request.method === "GET") {
        const users = await this.state.storage.get("users") || {};
        return new Response(JSON.stringify({ users }), {
          headers: { "Content-Type": "application/json" }
        });
      } else if (request.method === "POST") {
        const { users } = await request.json();
        await this.state.storage.put("users", users);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: "Storage operation failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Method not allowed", { status: 405 });
  }
  async handleSession(websocket, request) {
    const url = new URL(request.url);
    const username = url.searchParams.get("username");
    if (!username) {
      websocket.close(1008, "Username required");
      return;
    }
    websocket.accept();
    this.sessions.set(websocket, { username, joinedAt: Date.now() });
    this.users.set(username, {
      websocket,
      status: "Available",
      signOnTime: (/* @__PURE__ */ new Date()).toISOString()
    });
    websocket.send(JSON.stringify({
      type: "welcome",
      username,
      users: Array.from(this.users.keys()).filter((u) => u !== username)
    }));
    this.sendBuddyList(websocket, username);
    this.broadcastToAll({
      type: "user_joined",
      username,
      status: "Available",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    }, websocket);
    this.sendBuddyListToAll();
    websocket.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        await this.handleMessage(websocket, data, username);
      } catch (error) {
        console.error("Message handling error:", error);
      }
    });
    websocket.addEventListener("close", () => {
      this.handleDisconnect(websocket, username);
    });
  }
  async handleMessage(websocket, data, username) {
    switch (data.type) {
      case "message":
        await this.handleInstantMessage(websocket, data, username);
        break;
      case "status_change":
        await this.handleStatusChange(websocket, data, username);
        break;
      case "away_message":
        await this.handleAwayMessage(websocket, data, username);
        break;
      case "add_buddy":
        await this.handleAddBuddy(websocket, data, username);
        break;
      case "warn_user":
        await this.handleWarnUser(websocket, data, username);
        break;
    }
  }
  // Helper method to broadcast to all connected users
  broadcastToAll(message, excludeWebSocket = null) {
    for (const [user, userData] of this.users) {
      if (userData.websocket !== excludeWebSocket && userData.websocket.readyState === 1) {
        userData.websocket.send(JSON.stringify(message));
      }
    }
  }
  // Enhanced message handling for AIM-style instant messaging
  async handleInstantMessage(websocket, data, from) {
    const { to, message } = data;
    const targetUser = this.users.get(to);
    const messageData = {
      type: "message",
      from,
      to,
      message,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (targetUser && targetUser.websocket.readyState === 1) {
      targetUser.websocket.send(JSON.stringify(messageData));
      websocket.send(JSON.stringify({
        type: "message_delivered",
        to,
        timestamp: messageData.timestamp
      }));
    } else {
      websocket.send(JSON.stringify({
        type: "message_offline",
        to,
        message: `${to} is not currently signed on.`
      }));
    }
    await this.state.storage.put(`message:${Date.now()}:${from}:${to}`, messageData);
  }
  async handleStatusChange(websocket, data, username) {
    const { status, awayMessage } = data;
    const user = this.users.get(username);
    if (user) {
      user.status = status;
      user.awayMessage = awayMessage;
      this.users.set(username, user);
    }
    this.updateBuddyStatusForAll(username, status, awayMessage);
  }
  async handleAwayMessage(websocket, data, username) {
    const { message } = data;
    this.awayMessages.set(username, message);
    await this.handleStatusChange(websocket, {
      status: "Away",
      awayMessage: message
    }, username);
  }
  async handleAddBuddy(websocket, data, username) {
    const { buddyUsername } = data;
    let buddyList = this.buddyLists.get(username) || [];
    if (!buddyList.includes(buddyUsername)) {
      buddyList.push(buddyUsername);
      this.buddyLists.set(username, buddyList);
    }
    this.sendBuddyList(websocket, username);
  }
  async handleWarnUser(websocket, data, username) {
    const { targetUsername } = data;
    let warningLevel = this.warningLevels.get(targetUsername) || 0;
    warningLevel = Math.min(100, warningLevel + 10);
    this.warningLevels.set(targetUsername, warningLevel);
    const targetUser = this.users.get(targetUsername);
    if (targetUser && targetUser.websocket.readyState === 1) {
      targetUser.websocket.send(JSON.stringify({
        type: "warning_received",
        from: username,
        newWarningLevel: warningLevel
      }));
    }
  }
  // Send updated buddy list to all connected users
  sendBuddyListToAll() {
    for (const [user, userData] of this.users) {
      if (userData.websocket.readyState === 1) {
        this.sendBuddyList(userData.websocket, user);
      }
    }
  }
  sendBuddyList(websocket, username) {
    const buddiesWithStatus = [];
    for (const [buddyName, buddyUser] of this.users) {
      if (buddyName !== username) {
        buddiesWithStatus.push({
          username: buddyName,
          status: buddyUser.status,
          awayMessage: buddyUser.awayMessage || null,
          warningLevel: this.warningLevels.get(buddyName) || 0
        });
      }
    }
    websocket.send(JSON.stringify({
      type: "buddy_list",
      buddies: buddiesWithStatus
    }));
  }
  // Update buddy status for all users who have this user in their buddy list
  updateBuddyStatusForAll(username, status, awayMessage = null) {
    const statusMessage = {
      type: "buddy_status",
      username,
      status,
      awayMessage,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    for (const [user, userData] of this.users) {
      if (user !== username && userData.websocket.readyState === 1) {
        userData.websocket.send(JSON.stringify(statusMessage));
      }
    }
  }
  broadcastUserStatus(username, status, awayMessage = null) {
    const statusData = {
      type: "buddy_status",
      username,
      status,
      awayMessage
    };
    for (const [user, buddyList] of this.buddyLists) {
      if (buddyList.includes(username)) {
        const userSession = this.users.get(user);
        if (userSession && userSession.websocket.readyState === 1) {
          userSession.websocket.send(JSON.stringify(statusData));
        }
      }
    }
  }
  handleDisconnect(websocket, username) {
    this.sessions.delete(websocket);
    this.users.delete(username);
    this.broadcastToAll({
      type: "user_left",
      username,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.updateBuddyStatusForAll(username, "Offline");
    this.sendBuddyListToAll();
  }
};

// src/auth.js
async function handleAuth(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/auth/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/api/auth/register" && request.method === "POST") {
    return handleRegister(request, env);
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    return handleLogout(request, env);
  }
  return new Response("Not Found", { status: 404 });
}
__name(handleAuth, "handleAuth");
async function handleLogin(request, env) {
  try {
    const { username, password } = await request.json();
    const users = await getUsers(env);
    if (users[username] && users[username] === password) {
      const sessionToken = crypto.randomUUID();
      return new Response(JSON.stringify({
        success: true,
        sessionToken,
        username
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } else {
      return new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: "Login failed" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
__name(handleLogin, "handleLogin");
async function handleRegister(request, env) {
  try {
    const { username, password } = await request.json();
    if (!username || !password) {
      return new Response(JSON.stringify({ error: "Username and password are required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return new Response(JSON.stringify({ error: "Username must be 3-16 characters, letters, numbers, and underscores only" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    const users = await getUsers(env);
    if (users[username]) {
      return new Response(JSON.stringify({ error: "Username already exists" }), {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    users[username] = password;
    await saveUsers(env, users);
    return new Response(JSON.stringify({
      success: true,
      message: "Account created successfully"
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Registration failed" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
__name(handleRegister, "handleRegister");
async function getUsers(env) {
  try {
    const durableObjectId = env.CHAT_ROOM.idFromName("user-storage");
    const durableObject = env.CHAT_ROOM.get(durableObjectId);
    const response = await durableObject.fetch("http://localhost/users");
    if (response.ok) {
      const data = await response.json();
      return data.users || getDefaultUsers();
    }
  } catch (error) {
    console.error("Error getting users from storage:", error);
  }
  return getDefaultUsers();
}
__name(getUsers, "getUsers");
async function saveUsers(env, users) {
  try {
    const durableObjectId = env.CHAT_ROOM.idFromName("user-storage");
    const durableObject = env.CHAT_ROOM.get(durableObjectId);
    await durableObject.fetch("http://localhost/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ users })
    });
  } catch (error) {
    console.error("Error saving users to storage:", error);
  }
}
__name(saveUsers, "saveUsers");
function getDefaultUsers() {
  return {
    "parsnip_lover": "chaos123",
    "falcon_king": "garden456",
    "chaos_queen": "parsnip789"
  };
}
__name(getDefaultUsers, "getDefaultUsers");
async function handleLogout(request, env) {
  return new Response(JSON.stringify({ success: true }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
__name(handleLogout, "handleLogout");

// src/index.js
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
    if (path.startsWith("/api/auth/")) {
      return handleAuth(request, env);
    }
    if (path.startsWith("/api/room/")) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const roomName = path.split("/").pop();
      const id = env.CHAT_ROOM.idFromName(roomName);
      const room = env.CHAT_ROOM.get(id);
      return room.fetch(request);
    }
    if (path === "/" || path.startsWith("/static/")) {
      return handleStaticFiles(request, env);
    }
    return new Response("Not Found", { status: 404 });
  }
};
async function handleStaticFiles(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/static/bundle.js") {
    try {
      const asset = await env.ASSETS.fetch(new Request("https://fake-host/bundle.js"));
      if (asset.ok) {
        return new Response(asset.body, {
          headers: {
            "Content-Type": "application/javascript",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=31536000"
            // Cache for 1 year
          }
        });
      }
    } catch (error) {
      console.error("Error serving bundle.js:", error);
    }
    return new Response('console.log("Bundle not found - check build output");', {
      headers: {
        "Content-Type": "application/javascript",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Parsnip & Chaos Falcon AIM</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F955}</text></svg>">
      <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        .loading { 
          display: flex; 
          justify-content: center; 
          align-items: center; 
          height: 100vh; 
          background: linear-gradient(to bottom, #4A9AE6 0%, #87CEEB 30%, #98FB98 70%, #3CB371 100%);
          color: white;
          font-size: 18px;
        }
      </style>
    </head>
    <body>
      <div id="app">
        <div class="loading">\u{1F955} Loading Parsnip & Chaos Falcon AIM... \u{1F985}</div>
      </div>
      <script src="/static/bundle.js"><\/script>
      <script>
        // Fallback if React bundle doesn't load
        setTimeout(() => {
          if (document.getElementById('app').innerHTML.includes('Loading')) {
            console.log('React bundle failed to load, showing fallback UI');
            showFallbackUI();
          }
        }, 3000);

        function showFallbackUI() {
          const app = document.getElementById('app');
          app.innerHTML = \`
            <div style="
              min-height: 100vh; 
              display: flex; 
              align-items: center; 
              justify-content: center; 
              font-family: Arial, sans-serif;
              background: linear-gradient(to bottom, #4A9AE6 0%, #87CEEB 30%, #98FB98 70%, #3CB371 100%)
            ">
              <div style="
                width: 380px; 
                background-color: #F5F5DC; 
                border-radius: 8px; 
                border: 2px solid #D2B48C;
                box-shadow: 0 4px 8px rgba(0,0,0,0.3);
              ">
                <div style="
                  background: linear-gradient(to right, #4169E1, #6495ED);
                  color: white;
                  padding: 8px 12px;
                  font-weight: bold;
                  font-size: 14px;
                  border-radius: 6px 6px 0 0;
                  display: flex;
                  align-items: center;
                  gap: 8px;
                ">
                  <div style="
                    width: 16px; 
                    height: 16px; 
                    border-radius: 50%; 
                    background-color: #FFD700;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: black;
                    font-size: 12px;
                    font-weight: bold;
                  ">!</div>
                  <span>Sign On</span>
                </div>
                
                <div style="
                  background: linear-gradient(to bottom, #4169E1, #6495ED);
                  color: white;
                  padding: 24px;
                  text-align: center;
                ">
                  <div style="
                    width: 80px; 
                    height: 80px; 
                    margin: 0 auto 12px; 
                    border-radius: 50%; 
                    background-color: #FFD700;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: black;
                    font-size: 48px;
                    font-weight: bold;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                  ">!</div>
                  <h1 style="margin: 0 0 4px; font-size: 32px; font-weight: bold;">AOL Instant Messenger</h1>
                  <p style="margin: 0; font-size: 14px; opacity: 0.9;">Parsnip & Chaos Falcon Edition</p>
                </div>

                <div style="background-color: #F5F5DC; padding: 24px;">
                  <div style="margin-bottom: 16px;">
                    <label style="display: block; font-size: 14px; font-weight: bold; margin-bottom: 8px; color: #8B4513;">ScreenName</label>
                    <input type="text" id="username" placeholder="Enter your screen name" style="
                      width: 100%; 
                      padding: 8px 12px; 
                      border: 2px solid #999; 
                      font-size: 14px;
                      box-sizing: border-box;
                    ">
                  </div>
                  
                  <div style="margin-bottom: 20px;">
                    <label style="display: block; font-size: 14px; font-weight: bold; margin-bottom: 8px; color: #8B4513;">Password</label>
                    <input type="password" id="password" placeholder="Enter your password" style="
                      width: 100%; 
                      padding: 8px 12px; 
                      border: 2px solid #999; 
                      font-size: 14px;
                      box-sizing: border-box;
                    ">
                  </div>
                  
                  <div style="text-align: center; margin-bottom: 16px;">
                    <button onclick="handleLogin()" style="
                      background-color: #4169E1; 
                      color: white; 
                      padding: 8px 24px; 
                      border: 2px solid #1E3A8A; 
                      font-size: 14px; 
                      font-weight: bold;
                      cursor: pointer;
                      border-radius: 2px;
                    ">Sign On</button>
                  </div>
                  
                  <div style="text-align: center; font-size: 12px; color: #8B4513;">
                    Version: 12.13.2024 \u{1F955}\u{1F985}<br>
                    <small>Test with: parsnip_lover / chaos123</small>
                  </div>
                </div>
              </div>
            </div>
          \`;
        }

        async function handleLogin() {
          const username = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          
          if (!username || !password) {
            alert('Please enter both username and password');
            return;
          }
          
          try {
            const response = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });
            
            if (response.ok) {
              const data = await response.json();
              alert('Login successful! Welcome ' + username + '!\\n\\nFull AIM interface coming soon...');
            } else {
              alert('Login failed - check your credentials');
            }
          } catch (error) {
            console.error('Login error:', error);
            alert('Login failed - server error');
          }
        }
      <\/script>
    </body>
    </html>
  `;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
__name(handleStaticFiles, "handleStaticFiles");

// C:/Users/nikki/.nvm/versions/node/v22.16.0/bin/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/nikki/.nvm/versions/node/v22.16.0/bin/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-a7fhwL/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// C:/Users/nikki/.nvm/versions/node/v22.16.0/bin/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-a7fhwL/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  ChatRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
