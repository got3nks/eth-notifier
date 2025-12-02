const TelegramBot = require('node-telegram-bot-api');
const nconf = require('nconf');

let bot = null;

/**
 * Initialize the Telegram bot
 * @returns {TelegramBot|null}
 */
function initBot() {
    if (bot) return bot;

    const token = nconf.get('telegram:token');

    if (!token || token.length === 0) {
        console.error('No token configured in telegram:token');
        return null;
    }

    // Create bot instance without polling (we only send messages)
    bot = new TelegramBot(token, { polling: false });
    return bot;
}

/**
 * Sends a Telegram notification using node-telegram-bot-api
 * @param {string} msg - The message to send
 * @param {Object} opts - Options for the message
 * @param {string} opts.parse_mode - "Markdown", "HTML", or undefined for plain text
 * @param {boolean} opts.disable_web_page_preview - Disable link previews
 * @param {boolean} opts.disable_notification - Silent notification
 * @returns {Promise<void>}
 */
function sendTelegramNotification(msg, opts = {}) {
    const chatIds = nconf.get('telegram:chatId');

    if (!chatIds || chatIds.length === 0) {
        return Promise.reject(new Error('No chat IDs configured in telegram:chatId'));
    }

    const botInstance = initBot();
    if (!botInstance) {
        return Promise.reject(new Error('Failed to initialize Telegram bot'));
    }

    // Send to all chat IDs
    const promises = chatIds.map(chatId => {
        return sendToChat(botInstance, chatId, msg, opts);
    });

    return Promise.all(promises);
}

/**
 * Send message to a single chat
 * @param {TelegramBot} botInstance - The bot instance
 * @param {string|number} chatId - The chat ID
 * @param {string} msg - The message
 * @param {Object} opts - Options
 * @returns {Promise<Object>}
 */
function sendToChat(botInstance, chatId, msg, opts = {}) {
    const sendOptions = {};

    // Parse mode options
    if (opts.parse_mode) {
        sendOptions.parse_mode = opts.parse_mode;
    }

    // Disable web page preview
    if (opts.disable_web_page_preview) {
        sendOptions.disable_web_page_preview = true;
    }

    // Disable notification (silent)
    if (opts.disable_notification) {
        sendOptions.disable_notification = true;
    }

    return botInstance.sendMessage(chatId, msg, sendOptions)
        .then(response => {
            return {
                success: true,
                chatId: chatId,
                messageId: response.message_id
            };
        })
        .catch(error => {
            throw new Error(`Failed to send message to chat ${chatId}: ${error.message}`);
        });
}

/**
 * Send a file via Telegram
 * @param {string} filePath - Path to the file
 * @param {Object} opts - Options
 * @param {string} opts.type - "image", "video", or "document" (default: "document")
 * @param {string} opts.caption - Caption for the file
 * @returns {Promise<void>}
 */
function sendTelegramFile(filePath, opts = {}) {
    const chatIds = nconf.get('telegram:chatId');

    if (!chatIds || chatIds.length === 0) {
        return Promise.reject(new Error('No chat IDs configured in telegram:chatId'));
    }

    const botInstance = initBot();
    if (!botInstance) {
        return Promise.reject(new Error('Failed to initialize Telegram bot'));
    }

    const promises = chatIds.map(chatId => {
        return sendFileToChat(botInstance, chatId, filePath, opts);
    });

    return Promise.all(promises);
}

/**
 * Send file to a single chat
 * @param {TelegramBot} botInstance - The bot instance
 * @param {string|number} chatId - The chat ID
 * @param {string} filePath - Path to the file
 * @param {Object} opts - Options
 * @returns {Promise<Object>}
 */
function sendFileToChat(botInstance, chatId, filePath, opts = {}) {
    const fileOptions = {};

    // Caption
    if (opts.caption) {
        fileOptions.caption = opts.caption;
    }

    // Determine which method to use based on type
    const fileType = opts.type || 'document';
    let sendPromise;

    if (fileType === 'image') {
        sendPromise = botInstance.sendPhoto(chatId, filePath, fileOptions);
    } else if (fileType === 'video') {
        sendPromise = botInstance.sendVideo(chatId, filePath, fileOptions);
    } else {
        sendPromise = botInstance.sendDocument(chatId, filePath, fileOptions);
    }

    return sendPromise
        .then(response => {
            return {
                success: true,
                chatId: chatId,
                messageId: response.message_id
            };
        })
        .catch(error => {
            throw new Error(`Failed to send file to chat ${chatId}: ${error.message}`);
        });
}

module.exports = {
    sendTelegramNotification,
    sendTelegramFile
};