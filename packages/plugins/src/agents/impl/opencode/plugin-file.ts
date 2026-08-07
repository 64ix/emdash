// Verbatim source of the OpenCode emdash notifications plugin, embedded as a string constant.
export const OPENCODE_PLUGIN_CONTENT = `\
/* global fetch, process */

export const EmdashNotifications = async () => ({
  event: async ({ event }) => {
    const port = process.env.EMDASH_HOOK_PORT;
    const token = process.env.EMDASH_HOOK_NONCE ?? process.env.EMDASH_HOOK_TOKEN;
    const ptyId = process.env.EMDASH_PTY_ID;
    if (!port || !token || !ptyId) return;

    const prompt = getSubmittedPrompt(event);
    if (prompt) {
      await postToEmdash({ port, token, ptyId, type: 'start', body: { prompt } });
    }

    const sessionId = getOpenCodeSessionId(event);
    if (sessionId) {
      await postToEmdash({ port, token, ptyId, type: 'session', body: { sessionId } });
    }

    const payload = toEmdashPayload(event);
    if (!payload) return;

    await postToEmdash({ port, token, ptyId, type: payload.type, body: payload.body });
  },
});

async function postToEmdash({ port, token, ptyId, type, body }) {
  try {
    await fetch(\`http://127.0.0.1:\${port}/hook\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emdash-Token': token,
        'X-Emdash-Pty-Id': ptyId,
        'X-Emdash-Event-Type': type,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Hook delivery is best-effort and must never interrupt OpenCode.
  }
}

function getOpenCodeSessionId(event) {
  if (!event.type?.startsWith('session.')) return undefined;

  const infoId = event.properties?.info?.id;
  if (isOpenCodeSessionId(infoId)) return infoId.trim();

  const sessionId = event.properties?.sessionID;
  if (isOpenCodeSessionId(sessionId)) return sessionId.trim();

  return undefined;
}

// OpenCode publishes a user-submitted prompt as a user \`message.updated\` event
// followed by its \`message.part.updated\` text parts. Remember the user message
// ids and forward the first text part as a canonical \`start\` event so emdash
// can derive an automatic conversation title, mirroring Claude/Codex.
const userMessageIds = new Set();

function getSubmittedPrompt(event) {
  const info = event.properties?.info;
  if (event.type === 'message.updated' && info?.role === 'user' && typeof info.id === 'string') {
    userMessageIds.add(info.id);
    return undefined;
  }

  const part = event.properties?.part;
  if (event.type === 'message.part.updated' && part?.type === 'text') {
    if (userMessageIds.delete(part.messageID)) {
      const text = typeof part.text === 'string' ? part.text.trim() : '';
      return text || undefined;
    }
  }

  return undefined;
}

function isOpenCodeSessionId(value) {
  return typeof value === 'string' && value.trim().startsWith('ses');
}

function toEmdashPayload(event) {
  if (event.type === 'session.idle') {
    return {
      type: 'notification',
      body: {
        notification_type: 'idle_prompt',
        title: 'OpenCode',
        message: 'OpenCode is ready for input.',
      },
    };
  }

  if (event.type === 'session.error') {
    return {
      type: 'error',
      body: {
        title: 'OpenCode error',
        message: typeof event.properties?.error === 'string' ? event.properties.error : undefined,
      },
    };
  }

  return undefined;
}
`;
