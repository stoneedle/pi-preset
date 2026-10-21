// Conversation data is never cached by the service worker.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

function openPushDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pi-web-push", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("tags");
      request.result.createObjectStore("settings");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function pushRecord(store, key, value) {
  const db = await openPushDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        store,
        value === undefined ? "readonly" : "readwrite",
      );
      const request =
        value === undefined
          ? transaction.objectStore(store).get(key)
          : transaction.objectStore(store).put(value, key);
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function notificationTarget(data) {
  if (data.kind === "test") return new URL("/", self.location.origin);
  if (
    !["completed", "attention"].includes(data.kind) ||
    typeof data.sessionId !== "string" ||
    !data.sessionId.endsWith(".jsonl") ||
    data.sessionId.length > 512 ||
    /[\\/\x00]/.test(data.sessionId)
  )
    return null;
  const url = new URL("/session", self.location.origin);
  url.searchParams.set("id", data.sessionId);
  return url;
}

async function receivePush(data) {
  if (
    !data ||
    typeof data.eventId !== "string" ||
    data.eventId.length > 128 ||
    typeof data.tag !== "string" ||
    !Number.isSafeInteger(data.sequence) ||
    data.sequence < 1 ||
    typeof data.title !== "string" ||
    typeof data.body !== "string" ||
    !notificationTarget(data)
  )
    return;
  const previous = await pushRecord("tags", data.tag);
  if (previous && previous.sequence >= data.sequence) return;
  try {
    const response = await fetch(
      `/api/push/eligibility?event=${encodeURIComponent(data.eventId)}`,
      { cache: "no-store" },
    );
    if (response.ok && (await response.json()).active === false) return;
  } catch {
    // The encrypted transition remains valid evidence when the host is unreachable.
  }
  await self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag,
    renotify: false,
    icon: "/icon-192.png",
    badge: "/icon-maskable-512.png",
    data: {
      eventId: data.eventId,
      kind: data.kind,
      sessionId: data.sessionId,
      identity: data.identity,
    },
  });
  await pushRecord("tags", data.tag, { sequence: data.sequence });
}

let pushWork = Promise.resolve();
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  pushWork = pushWork.catch(() => {}).then(() => receivePush(data));
  event.waitUntil(pushWork);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = notificationTarget(event.notification.data);
  if (!target) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        const url = new URL(client.url);
        if (
          url.origin === target.origin &&
          url.pathname === target.pathname &&
          url.searchParams.get("id") === target.searchParams.get("id")
        ) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "pi-web:push-settings") {
    event.waitUntil(
      pushRecord("settings", "subscription", message.value).then(
        () => event.ports[0]?.postMessage({ saved: true }),
        () => event.ports[0]?.postMessage({ saved: false }),
      ),
    );
  } else if (message?.type === "pi-web:read") {
    event.waitUntil(
      self.registration.getNotifications().then((notifications) => {
        for (const notification of notifications) {
          if (
            notification.data?.kind === "completed" &&
            notification.data.sessionId === message.sessionId &&
            notification.data.identity === message.replyId
          )
            notification.close();
        }
      }),
    );
  }
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const saved = await pushRecord("settings", "subscription");
      if (!saved?.endpoint || !saved.publicKey) return;
      const subscription =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe(
          event.oldSubscription?.options || {
            userVisibleOnly: true,
            applicationServerKey: saved.publicKey,
          },
        ));
      const response = await fetch("/api/push/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          previousEndpoint: event.oldSubscription?.endpoint || saved.endpoint,
        }),
      });
      if (!response.ok) throw new Error("推送订阅续订失败");
      await pushRecord("settings", "subscription", {
        endpoint: subscription.endpoint,
        publicKey: saved.publicKey,
      });
    })(),
  );
});
