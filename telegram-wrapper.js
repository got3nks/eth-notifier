const { spawn } = require('child_process');
const nconf = require('nconf');

// Path to telegram-cli-wrapper executable
const TELEGRAM_CLI_WRAPPER = process.env.TELEGRAM_CLI_WRAPPER || '/usr/local/bin/telegram-cli-wrapper';

/**
 * Sends a Telegram notification using telegram-cli-wrapper
 * @param {string} msg - The message to send
 * @param {Object} opts - Options for the message
 * @param {string} opts.parse_mode - "Markdown", "HTML", or undefined for plain text
 * @param {boolean} opts.disable_web_page_preview - Disable link previews
 * @param {boolean} opts.disable_notification - Silent notification
 * @param {string} opts.title - Title for the message (bolded if parse_mode is set)
 * @param {boolean} opts.code_mode - Send as monospace code block
 * @returns {Promise<void>}
 */
function sendTelegramNotification(msg, opts = {}) {
    const token = nconf.get('telegram:token'),
        chatIds = nconf.get('telegram:chatId');

    if (!token || token.length === 0) {
        return Promise.reject(new Error('No token configured in telegram:token'));
    }

    if (!chatIds || chatIds.length === 0) {
        return Promise.reject(new Error('No chat IDs configured in telegram:chatId'));
    }

    // Send to all chat IDs
    const promises = chatIds.map(chatId => {
        return sendToChat(token, chatId, msg, opts);
    });

    return Promise.all(promises);
}

/**
 * Send message to a single chat
 * @param {string|number} chatId - The chat ID
 * @param {string} msg - The message
 * @param {Object} opts - Options
 * @returns {Promise<Object>}
 */
function sendToChat(token, chatId, msg, opts = {}) {
    return new Promise((resolve, reject) => {
        const args = ['-t', token.toString(), '-c', chatId.toString()];

        // Parse mode options
        if (opts.parse_mode === 'Markdown') {
            args.push('-M');
        } else if (opts.parse_mode === 'HTML') {
            args.push('-H');
        }

        // Code mode (wraps in code block)
        if (opts.code_mode) {
            args.push('-C');
        }

        // Disable web page preview
        if (opts.disable_web_page_preview) {
            args.push('-D');
        }

        // Disable notification (silent)
        if (opts.disable_notification) {
            args.push('-N');
        }

        // Title
        if (opts.title) {
            args.push('-T', opts.title);
        }

        // Pass message as last argument (telegram-cli-wrapper supports this)
        args.push(msg);

        // Spawn the telegram-cli-wrapper process
        const telegram = spawn(TELEGRAM_CLI_WRAPPER, args);

        let stdout = '';
        let stderr = '';

        // Collect output
        telegram.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        telegram.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        // Handle process completion
        telegram.on('close', (code) => {
            if (code === 0) {
                resolve({
                    success: true,
                    chatId: chatId,
                    stdout: stdout,
                    stderr: stderr
                });
            } else {
                reject(new Error(`telegram-cli-wrapper exited with code ${code}. stderr: ${stderr}, stdout: ${stdout}`));
            }
        });

        // Handle process errors
        telegram.on('error', (err) => {
            reject(new Error(`Failed to spawn telegram-cli-wrapper: ${err.message}`));
        });
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
    const token = nconf.get('telegram:token'),
        chatIds = nconf.get('telegram:chatId');

    if (!token || token.length === 0) {
        return Promise.reject(new Error('No token configured in telegram:token'));
    }

    if (!chatIds || chatIds.length === 0) {
        return Promise.reject(new Error('No chat IDs configured in telegram:chatId'));
    }

    const promises = chatIds.map(chatId => {
        return sendFileToChat(token, chatId, filePath, opts);
    });

    return Promise.all(promises);
}

/**
 * Send file to a single chat
 * @param {string|number} chatId - The chat ID
 * @param {string} filePath - Path to the file
 * @param {Object} opts - Options
 * @returns {Promise<Object>}
 */
function sendFileToChat(token, chatId, filePath, opts = {}) {
    return new Promise((resolve, reject) => {
        const args = ['-t', token.toString(), '-c', chatId.toString()];

        // File type
        const fileType = opts.type || 'document';
        if (fileType === 'image') {
            args.push('-i', filePath);
        } else if (fileType === 'video') {
            args.push('-V', filePath);
        } else {
            args.push('-f', filePath);
        }

        // Caption
        if (opts.caption) {
            // Pass caption as last argument
            args.push(opts.caption);

            const telegram = spawn(TELEGRAM_CLI_WRAPPER, args);

            let stdout = '';
            let stderr = '';

            telegram.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            telegram.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            telegram.on('close', (code) => {
                if (code === 0) {
                    resolve({
                        success: true,
                        chatId: chatId,
                        stdout: stdout,
                        stderr: stderr
                    });
                } else {
                    reject(new Error(`telegram-cli-wrapper exited with code ${code}. stderr: ${stderr}`));
                }
            });

            telegram.on('error', (err) => {
                reject(new Error(`Failed to spawn telegram-cli-wrapper: ${err.message}`));
            });
        } else {
            // No caption, just spawn without stdin
            const telegram = spawn(TELEGRAM_CLI_WRAPPER, args);

            let stdout = '';
            let stderr = '';

            telegram.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            telegram.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            telegram.on('close', (code) => {
                if (code === 0) {
                    resolve({
                        success: true,
                        chatId: chatId,
                        stdout: stdout,
                        stderr: stderr
                    });
                } else {
                    reject(new Error(`telegram-cli-wrapper exited with code ${code}. stderr: ${stderr}`));
                }
            });

            telegram.on('error', (err) => {
                reject(new Error(`Failed to spawn telegram-cli-wrapper: ${err.message}`));
            });
        }
    });
}

module.exports = {
    sendTelegramNotification,
    sendTelegramFile
};