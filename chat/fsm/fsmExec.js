// fsmExec.js – FSM terminal states for MCP tool executions (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { ctx } from "../modules/context.js";

export async function runStateExecSuccess() {
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid && ctx.fsmSessions[pid] ? ctx.fsmSessions[pid] : null;
    const toolName = sess?.toolName || ctx.toolExecutionMode || "tool";

    log(`[TMDBG FSM] exec_success pid=${pid} tool=${toolName}`);
  } catch (e) {
    log(`[TMDBG FSM] runStateExecSuccess failed: ${e}`, "error");
  } finally {
    try {
      await notifyFsmCompleteInternal(true);
    } catch (e) {
      log(
        `[TMDBG FSM] notifyFsmCompleteInternal(success) failed: ${e}`,
        "warn"
      );
    } finally {
      try {
        // DON'T remove tool bubbles on FSM success either - let agent response handle cleanup
        // This ensures consistent behavior: all tool bubbles are cleaned up when conversation completes
        const container = document.getElementById("chat-container");
        const pid = ctx.activePid || ctx.activeToolCallId || 0;

        if (pid) {
          // Only remove loading state from the specific FSM tool bubble
          const fsmToolBubble = container?.querySelector?.(
            `.agent-message.tool[data-pid="${pid}"]`
          );
          if (fsmToolBubble) {
            try {
              fsmToolBubble.classList.remove("loading");
              log(
                `[TMDBG FSM] Removed loading state from FSM tool bubble for pid=${pid}`
              );
            } catch (_) {}
          }
        }

        log(
          `[TMDBG FSM] FSM tool completed successfully, preserving tool bubbles for agent response`
        );
      } catch (e) {
        log(`[TMDBG FSM] FSM success state update failed: ${e}`, "warn");
      }
      // Cleanup FSM markers
      cleanupFsmSession();
    }
  }
}

// TODO: should we merge this with runStateExecSuccess and just have a single state? or is it clearer for the FSM planner this way?
export async function runStateExecFail() {
  try {
    await notifyFsmCompleteInternal(false);
  } catch (e) {
    log(`[TMDBG FSM] notifyFsmCompleteInternal(fail) failed: ${e}`, "warn");
  } finally {
    try {
      // Mark failed FSM tool bubble with error state instead of clearing all bubbles
      const container = document.getElementById("chat-container");
      const pid = ctx.activePid || ctx.activeToolCallId || 0;

      if (pid) {
        // Only mark the specific failed FSM tool bubble with error state
        const fsmToolBubble = container?.querySelector?.(
          `.agent-message.tool[data-pid="${pid}"]`
        );
        if (fsmToolBubble) {
          try {
            fsmToolBubble.classList.remove("loading");
            fsmToolBubble.classList.add("error");
            log(
              `[TMDBG FSM] Marked FSM tool bubble with error state for pid=${pid}`
            );
          } catch (_) {}
        }
      }

      // DON'T remove all tool bubbles on FSM failure - only clean up when conversation completes
      log(
        `[TMDBG FSM] FSM tool failed but preserving tool bubbles for agent response`
      );
    } catch (e) {
      log(`[TMDBG FSM] FSM error state marking failed: ${e}`, "warn");
    }
    // Cleanup FSM markers
    cleanupFsmSession();
  }
}

function cleanupFsmSession() {
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid && ctx.fsmSessions[pid]) {
      delete ctx.fsmSessions[pid];
    }
  } catch (_) {}
  ctx.activePid = 0;
  ctx.awaitingPid = 0;
  ctx.toolExecutionMode = null;
  ctx.activeToolCallId = null;
}

async function notifyFsmCompleteInternal(success) {
  try {
    const pidDbg = ctx.activePid || ctx.activeToolCallId || 0;
    log(
      `[TMDBG FSM] notifyFsmCompleteInternal success=${success} pid=${pidDbg} state=${ctx.state}`
    );
  } catch (_) {
    log(`[TMDBG FSM] notifyFsmCompleteInternal success=${success}`);
  }
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid && ctx.fsmSessions[pid] ? ctx.fsmSessions[pid] : null;
    const toolName = sess?.toolName || ctx.toolExecutionMode || "tool";

    // Prepare result using tool-specific completion handler if available
    let output = success
      ? "FSM tool completed successfully."
      : sess?.failReason
      ? `FSM tool failed: ${sess.failReason}`
      : "FSM tool failed.";
    try {
      const currentState = ctx.state;
      const prevState = sess?.fsmPrevState || null;
      const mod = await import(`../tools/${toolName}.js`);
      if (mod && typeof mod.completeExecution === "function") {
        output = await mod.completeExecution(currentState, prevState);
      }
    } catch (e) {
      log(
        `[TMDBG FSM] completeExecution for tool '${toolName}' failed: ${e}`,
        "warn"
      );
    }

    // Resolve waiter if present
    try {
      const waiter = ctx.fsmWaiters && pid ? ctx.fsmWaiters[pid] : null;
      if (waiter && typeof waiter.resolve === "function") {
        try {
          log(`[TMDBG FSM] resolving waiter for pid=${pid}`);
        } catch (_) {}
        try {
          waiter.resolve({ ok: !!success, output });
        } catch (_) {}
        try {
          delete ctx.fsmWaiters[pid];
        } catch (_) {}
      }
    } catch (_) {}
  } catch (e) {
    log(
      `[TMDBG FSM] notifyFsmCompleteInternal unexpected error: ${e}`,
      "error"
    );
  }
}

export async function cancelFsmSession(pid, reason) {
  try {
    if (!pid) return;
    // Attach reason to the session if exists
    try {
      ctx.fsmSessions[pid] = ctx.fsmSessions[pid] || {
        toolName: ctx.toolExecutionMode || "tool",
      };
      ctx.fsmSessions[pid].failReason = reason || "Cancelled by system";
    } catch (_) {}
    ctx.activePid = pid;
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
  } catch (e) {
    log(`[TMDBG FSM] cancelFsmSession failed: ${e}`, "error");
  }
}
