// Shared mutable state for chat window finite-state machine
// Thunderbird 140, MV3 compatible.


export const ctx = {
  chatHistory: [],
  actionHistory: [],
  stateHistory: [],
  state: null,
  // PID routing: 0 means top-level converse; non-zero means FSM tool_call_id
  activePid: 0,
  awaitingPid: 0,
  selectedEmailList: [],
  selectedRecipientList: [],
  selectedMessageIds: [], // Currently selected message IDs (tracked for @ mention "selected email" feature)
  greetedUser: false,
  rawUserTexts: [], // raw text entries from user during compose workflow
  pendingSuggestion: "", // suggested default user input when awaiting input
  // Persist agent converse message list across consecutive converse cycles
  // Pattern: converse -> init_and_greet_user -> converse
  agentConverseMessages: null,
  // FSM tool execution context
  toolExecutionMode: null,
  activeToolCallId: null, // current MCP tool call id for FSM workflows
  // Map pid (tool_call_id) -> { fsmPrevState: string, fsmUserInput: string, toolName, startedAt }
  fsmSessions: Object.create(null),
  // Map pid (tool_call_id) -> { resolve: Function }
  // Used by wsTools to await exec_success/exec_fail notifications
  fsmWaiters: Object.create(null),
  // ID Translation mapping for this chat session
  idTranslation: {
    idMap: new Map(), // numericId -> realId
    nextNumericId: 1,
    lastAccessed: Date.now()
  },
  // Entity map for events/contacts with compound IDs
  // Key: compound numeric ID (e.g., "1:2"), Value: { type, compoundNumericId, realIds, ... }
  entityMap: new Map(),
  // Retry state: stores last user message for retry functionality
  lastUserMessage: null, // The last user message text that can be retried
  canRetry: false, // Whether retry is available (true after error, false after successful response)
};

// --- History length guards ---
const MAX_HISTORY = 100;
function makeCappedArray(arr) {
  return new Proxy(arr, {
    get(target, prop) {
      if (prop === "push") {
        return function (...args) {
          const res = Array.prototype.push.apply(target, args);
          while (target.length > MAX_HISTORY) target.shift();
          return res;
        };
      }
      return target[prop];
    },
  });
}

ctx.rawUserTexts  = makeCappedArray(ctx.rawUserTexts);

// Initialize or reset an FSM session for a given pid and toolName.
// Seeds per-session histories and a system prompt for agent planning.
export function initFsmSession(pid, toolName) {
  try {
    if (!pid) return null;
    const sess = {
      toolName: String(toolName || "tool"),
      startedAt: Date.now(),
      fsmPrevState: ctx.state || null,
      fsmUserInput: null,
    };
    ctx.fsmSessions[pid] = sess;
    return sess;
  } catch (_) {
    return null;
  }
}

// (Context switching helpers removed – FSM sessions are isolated by pid)