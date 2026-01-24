var TabMail = TabMail || {};

/**
 * Centralized logging system for TabMail compose autocomplete.
 * 
 * Usage:
 *   TabMail.log.info('core', 'Request completed', data);
 *   TabMail.log.debug('diff', 'Computing diff for texts');
 *   TabMail.log.trace('autohideDiff', 'Handling keystroke');
 *   TabMail.log.error('api', 'Failed to fetch', error);
 *   TabMail.log.warn('events', 'Unexpected state');
 */
TabMail.log = (function() {
  const LOG_LEVELS = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    TRACE: 5
  };

  const LEVEL_NAMES = {
    0: 'NONE',
    1: 'ERROR',
    2: 'WARN',
    3: 'INFO',
    4: 'DEBUG',
    5: 'TRACE'
  };

  /**
   * Gets the effective log level for a given category.
   * @param {string} category - The logging category (e.g., 'core', 'diff', 'autohideDiff')
   * @returns {number} The log level (0-5)
   */
  function getLogLevel(category) {
    const config = TabMail.config;
    if (!config) return LOG_LEVELS.DEBUG; // Default if config not loaded yet
    
    // Check if category has a specific override
    if (config.logCategories && config.logCategories[category] !== null && config.logCategories[category] !== undefined) {
      return config.logCategories[category];
    }
    
    // Fall back to global LOG_LEVEL
    return config.LOG_LEVEL !== undefined ? config.LOG_LEVEL : LOG_LEVELS.DEBUG;
  }

  /**
   * Internal logging function.
   * @param {number} level - Log level for this message
   * @param {string} category - Category identifier
   * @param {string} message - Log message
   * @param {...any} args - Additional arguments to log
   */
  function logWithLevel(level, category, message, ...args) {
    const effectiveLevel = getLogLevel(category);
    
    // Skip if this message's level is higher than the category's effective level
    if (level > effectiveLevel) {
      return;
    }

    // Format the prefix with category
    const prefix = `[TabMail ${category}]`;
    
    // Use appropriate console method
    if (level === LOG_LEVELS.ERROR) {
      console.error(prefix, message, ...args);
    } else if (level === LOG_LEVELS.WARN) {
      console.warn(prefix, message, ...args);
    } else {
      console.log(prefix, message, ...args);
    }
  }

  return {
    // Log levels constant for external use
    LEVELS: LOG_LEVELS,

    /**
     * Log an error message (level 1)
     * @param {string} category - Category identifier
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    error: function(category, message, ...args) {
      logWithLevel(LOG_LEVELS.ERROR, category, message, ...args);
    },

    /**
     * Log a warning message (level 2)
     * @param {string} category - Category identifier
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    warn: function(category, message, ...args) {
      logWithLevel(LOG_LEVELS.WARN, category, message, ...args);
    },

    /**
     * Log an info message (level 3) - important information
     * @param {string} category - Category identifier
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    info: function(category, message, ...args) {
      logWithLevel(LOG_LEVELS.INFO, category, message, ...args);
    },

    /**
     * Log a debug message (level 4) - development information
     * @param {string} category - Category identifier
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    debug: function(category, message, ...args) {
      logWithLevel(LOG_LEVELS.DEBUG, category, message, ...args);
    },

    /**
     * Log a trace message (level 5) - very frequent/detailed events
     * @param {string} category - Category identifier
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    trace: function(category, message, ...args) {
      logWithLevel(LOG_LEVELS.TRACE, category, message, ...args);
    },

    /**
     * Get current log level for a category (for debugging the logger itself)
     * @param {string} category - Category identifier
     * @returns {string} Current log level name
     */
    getCurrentLevel: function(category) {
      const level = getLogLevel(category);
      return LEVEL_NAMES[level] || 'UNKNOWN';
    }
  };
})();

