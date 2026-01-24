var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Fetches the corrected text from the backend.
   * @param {object} context An object containing the original message.
   * @returns {Promise<object|null>} An object with { usertext, suggestion } or null on error.
   */
  getCorrectionFromServer: async function(context) {
    try {
      const isLocal = context.isLocal === true;
      TabMail.log.debug('backend', `Sending correction request (mode: ${isLocal ? 'LOCAL' : 'GLOBAL'}).`);
      const data = await browser.runtime.sendMessage({
        type: "getSuggestion",
        context: {
          userMessage: context.userMessage,
          quoteAndSignature: context.quoteAndSignature,
          cursorPosition: context.cursorPosition,
          isLocal: isLocal,
        },
      });

      // console.log('[TabMail API] Response from background:', data);

      if (data.error) {
        TabMail.log.error('backend', `Received error from background: ${data.error}`);
        return null;
      }

      if (data.sessionId) {
        TabMail.state.sessionId = data.sessionId;
        // console.log(`[TabMail API] Session ID set to: ${TabMail.state.sessionId}`);
      }

      if (data.suggestion && data.suggestion.trim().length > 0) {
        // console.log(`[TabMail] Received suggestion from background.`);
        return {
          usertext: data.usertext || context.userMessage,
          suggestion: data.suggestion,
          directReplace: data.directReplace || false,
        };
      }

      return null;
    } catch (error) {
      if (error.message.includes("Could not establish connection. Receiving end does not exist.") ||
          error.message.includes("Actor 'Conduits' destroyed")) {
        TabMail.log.warn('backend', "The compose window was closed before the backend could respond. This is expected during synchronous debugging and can be ignored.");
      } else {
        TabMail.log.error('backend', "CRITICAL: Error communicating with background.", error);
      }
      return null;
    }
  },

  /**
   * Notifies the backend that a specific suggestion has been rejected by the user.
   * @param {string} sessionId The active session ID.
   * @param {HTMLElement} rejectedSpan The actual span element that was rejected.
   * @param {string} diffType The type of diff ('insert' or 'delete').
   */
  notifyRejection: function(sessionId, rejectedSpan, diffType) {
    if (!sessionId || !rejectedSpan || !rejectedSpan.textContent) {
      TabMail.log.warn('backend', "Cannot notify rejection without session ID or a valid rejected span.");
      return;
    }

    const rejectedText = rejectedSpan.textContent;
    const fullSentence = TabMail.extractSentenceAroundSpan(rejectedSpan, diffType);

    TabMail.log.info('backend', `Notifying background script of rejection for session ${sessionId}: "${rejectedText}" in sentence "${fullSentence}"`);

    browser.runtime.sendMessage({
      type: 'rejectSuggestion',
      sessionId: sessionId,
      rejectedText: rejectedText,
      fullSentence: fullSentence,
      diffType: diffType,
    }).catch(error => {
      TabMail.log.error('backend', "Error sending rejection message to background script:", error);
    });
  },
}); 