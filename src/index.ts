import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Add this utility function
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        // Add exponential backoff before retries
        await sleep(initialDelay * Math.pow(2, i - 1));
      }
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry if message not found
      if (error?.response?.description?.includes('message to edit not found')) {
        throw error;
      }

      // Ignore "message not modified" error
      if (error?.response?.description?.includes('message is not modified')) {
        return error.response as T;
      }

      if (error?.response?.error_code === 429) {
        const retryAfter = (error.response.parameters?.retry_after || 1) * 1000;
        console.log(`Rate limited. Waiting ${retryAfter}ms before retry ${i + 1}/${maxRetries}`);
        await sleep(retryAfter);
        continue;
      }

      // If we're on the last try, throw the error
      if (i === maxRetries - 1) {
        throw error;
      }
    }
  }

  throw lastError;
}
// Initialize bot with your token
const bot = new Telegraf(process.env.BOT_TOKEN ?? "");

// Token configurations
enum TokenType {
  SEND = 'SEND',
  USDC = 'USDC',
  ETH = 'ETH'
}

interface TokenConfig {
  address?: string;
  decimals: bigint
}

const TOKEN_CONFIG: Record<TokenType, TokenConfig> = {
  [TokenType.SEND]: {
    address: '0x3f14920c99BEB920Afa163031c4e47a3e03B3e4A',
    decimals: 0n
  },
  [TokenType.USDC]: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6n
  },
  [TokenType.ETH]: {
    address: 'eth',
    decimals: 18n
  }
};

const SEND_URL = 'https://send.app/send';
const BASE_URL = 'https://send.app/send/confirm';

interface SendCommand {
  recipient: string;
  amount?: string;
  token?: TokenType;
}

function parseSendCommand(text: string): SendCommand | null {
  // Remove /send and trim to parse the rest
  const content = text.slice(5).trim();

  // Match patterns in specific order
  const patterns = {
    sendtag: /\/([a-zA-Z0-9_]+)/,      // Must start with /
    amount: /(\d+(?:\.\d+)?)/,         // number format
    token: /(SEND|USDC|ETH)(?:\s+|$)/i  // More lenient token match
  };
  const sendtagMatch = content.match(patterns.sendtag);
  if (!sendtagMatch?.[1]) {
    return null;
  }

  const params: SendCommand = {
    recipient: sendtagMatch[1],
  };

  // Extract amount - search after sendtag
  const afterSendtag = content.slice(content.indexOf(sendtagMatch[0]) + sendtagMatch[0].length);
  const amountMatch = afterSendtag.match(patterns.amount);
  if (amountMatch?.[1]) {
    params.amount = amountMatch[1];
  }

  // Extract token - search after amount if exists
  const tokenMatch = afterSendtag.match(patterns.token);
  if (tokenMatch?.[1]) {
    params.token = tokenMatch[1].toUpperCase() as TokenType;
  }

  return params;
}


function generateSendUrl(command: SendCommand): string {
  const params: Record<string, string> = {
    idType: 'tag',
    recipient: command.recipient,
  };

  const tokenConfig = TOKEN_CONFIG[command.token ?? "SEND"];
  if (tokenConfig.address) {
    params.sendToken = tokenConfig.address;
  }

  let amount = parseFloat(command.amount?.replace(/,/g, '') ?? "");
  if (!isNaN(amount) && amount > 0.) {
    const amountInSmallestUnit = amount * Number(10n ** tokenConfig.decimals);
    params.amount = BigInt(Math.round(amountInSmallestUnit)).toString();
  }

  const baseUrl = !params.amount ? SEND_URL : BASE_URL;
  const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;

  return url;
}

// Modify the button text generation
function generateButtonText(sender: string, recipient: string, amount?: string, token?: TokenType): string {
  return amount ?
    `➡️ ${sender} is sending ${amount} ${token ?? 'SEND'} to /${recipient}` :
    `➡️ ${sender} is sending to /${recipient}`;
}

function generateGameButtonText(winner: string, game: GameState): string {
  return `➡️ ${game.masterName} send ${game.amount} to ${winner}`
}

async function deleteMessage(ctx: Context, messageId: number) {
  if ('chat' in ctx && ctx.chat && messageId) {
    try {
      const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.botInfo.id);
      const canDelete = ['administrator', 'creator'].includes(chatMember.status) &&
        ('can_delete_messages' in chatMember ? chatMember.can_delete_messages : false);

      // Only attempt to delete if we have permission
      if (canDelete && 'message' in ctx && ctx.message && 'message_id' in ctx.message) {
        try {
          await ctx.deleteMessage(messageId);
        } catch (deleteError: any) {
          console.log(`Delete error details: ${JSON.stringify(deleteError)}`);
          if (deleteError.response?.description.includes('message to delete not found')) {
            console.log('Message already deleted or too old');
          } else {
            console.log(`Unexpected delete error: ${deleteError.message}`);
          }
        }
      } else {
        console.log('Bot lacks delete permissions in this chat');
      }
    } catch (permissionError: any) {
      console.log(`Could not check permissions: ${permissionError.message}`);
    }
  }
}

async function sendMessage(ctx: Context, text: string) {
  try {
    // Delete the original command message if possible
    ctx.message && deleteMessage(ctx, ctx.message.message_id);

    // Send the response as a self-destructing message
    return await ctx.reply(text, {
      parse_mode: 'Markdown',
      disable_notification: true, // Silent notification
    });

  } catch (error) {
    console.error('Error in sendMessage:', error);
  }
}

const helpMessage = `
*/send*
• Reply with /send to get send link
• /send /vic 100 SEND

*/guess*
• /guess - Random slots, 1000 SEND prize
• /guess 10 2000 - 10 slots, 2000 SEND prize
• /kill - End your game
`;

// Handle /help command
bot.command('help', async (ctx) => {
  await sendMessage(ctx, helpMessage);
});

// Handle /send command
bot.command('send', async (ctx) => {
  if (!ctx.chat) {
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }
  const parsedCommand = parseSendCommand(ctx.message.text);
  if (parsedCommand) {
    const url = generateSendUrl(parsedCommand);
    const text = generateButtonText(ctx.from.first_name, parsedCommand.recipient, parsedCommand.amount, parsedCommand.token);

    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [[
          { text: '/send', url }
        ]]
      },
      disable_notification: true
    });
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  if (ctx.message.reply_to_message) {
    const repliedToUser = ctx.message.reply_to_message.from;
    const isReplyToSelf = repliedToUser?.id === ctx.message.from.id;

    if (repliedToUser && !isReplyToSelf) {
      const parsedName = repliedToUser.first_name?.split('/');
      const hasSendtag = parsedName !== undefined && parsedName.length > 1
      const cleanSendtag = hasSendtag && parsedName[1].split(/[\s\u{1F300}-\u{1F9FF}]/u)[0].replace(/[^a-zA-Z0-9_]/gu, '').trim();


      if (hasSendtag && cleanSendtag) {
        // Check if there's any content after /send
        const content = ctx.message.text.slice(5).trim();

        // If no content, just do a quick send
        if (!content) {
          const command: SendCommand = { recipient: cleanSendtag };
          const url = generateSendUrl(command);
          const text = generateButtonText(ctx.from.first_name, cleanSendtag);

          await ctx.reply(text, {
            reply_markup: {
              inline_keyboard: [[
                { text: '/send', url }
              ]]
            },
            disable_notification: true
          });
          queueMessageDeletion(ctx, ctx.message.message_id);
          return;
        }

        // Otherwise parse amount/token
        const cleanContent = content.replace(/,/g, '');
        const amountMatch = cleanContent.match(/(\d+(?:\.\d+)?)/);
        const tokenMatch = cleanContent.match(/(SEND|USDC|ETH)(?:\s+|$)/i);

        const command: SendCommand = {
          recipient: cleanSendtag,
          amount: amountMatch?.[1],
          token: (tokenMatch?.[1]?.toUpperCase() ?? 'SEND') as TokenType
        };

        const url = generateSendUrl(command);
        const text = generateButtonText(ctx.from.first_name, command.recipient, command.amount, command.token);

        await ctx.reply(text, {
          reply_markup: {
            inline_keyboard: [[
              { text: '/send', url }
            ]]
          },
          disable_notification: true
        });
        queueMessageDeletion(ctx, ctx.message.message_id);
        return;
      }
    }
  }

  queueMessageDeletion(ctx, ctx.message.message_id);

});

// Add at the top with other interfaces
interface DeleteTask {
  chatId: number;
  messageId: number;
}

// Add with other global variables
const deleteQueue: DeleteTask[] = [];
let isProcessingQueue = false;

// Add this new function to handle deletions
async function queueMessageDeletion(ctx: Context, messageId: number) {
  if (!ctx.chat) return;

  const task = {
    chatId: ctx.chat.id,
    messageId: messageId
  };

  // If it's our bot's message, prioritize it
  if (ctx.from?.id === bot.botInfo?.id) {
    deleteQueue.unshift(task);
  } else {
    deleteQueue.push(task);
  }

  if (!isProcessingQueue) {
    processDeleteQueue();
  }
}

async function processDeleteQueue() {
  isProcessingQueue = true;

  while (deleteQueue.length > 0) {
    const task = deleteQueue.shift();
    if (!task) continue;

    try {
      await withRetry(async () => {
        await bot.telegram.deleteMessage(task.chatId, task.messageId);
      });
      // Increase delay between deletions
      await sleep(100); // 100ms between deletions
    } catch (error) {
      console.log('Error deleting message:', error);
    }
  }

  isProcessingQueue = false;
}



// Add with other global variables
const chatCooldowns: Map<number, {
  active: boolean,
  messageId?: number,
  lastUpdate: number,
  endTime: number,
}> = new Map();

async function startCooldown(ctx: Context, chatId: number) {
  try {
    const cooldownMsg = await ctx.reply(
      `⏳ Sendtag Cooldown: 45 sec`,
      { disable_notification: true }
    );

    const cooldown = {
      active: true,
      messageId: cooldownMsg.message_id,
      lastUpdate: Date.now(),
      endTime: Math.floor(Date.now() / 1000) + 45,
    };
    chatCooldowns.set(chatId, cooldown);

    // Clear after 30 seconds
    setTimeout(() => {
      const cooldown = chatCooldowns.get(chatId);
      if (cooldown?.messageId) {
        chatCooldowns.delete(chatId);
        queueMessageDeletion(ctx, cooldown.messageId);
      }
    }, 30000);

  } catch (error) {
    console.error('Error starting cooldown:', error);
    chatCooldowns.delete(chatId);
  }
}



// Add these at the top with other interfaces
interface Player {
  sendtag: string;
  userId: number;
  callbackQueryId: string;
}


// Replace the current game tracking with channel-specific tracking
interface GameState {
  winningNumber: number;
  active: boolean;
  players: Player[];
  chatId: number;
  messageId: number;
  maxNumber: number;
  amount: string;
  masterId: number;
  masterName: string;
}

// Track games by chat ID
let activeGames: Map<number, GameState> = new Map();

bot.command('guess', async (ctx) => {
  try {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    let game = activeGames.get(chatId);
    let cooldown = chatCooldowns.get(chatId);
    if (cooldown?.active) {
      cooldown.messageId && queueMessageDeletion(ctx, cooldown.messageId);
      cooldown.active = false;
    }

    // Check if there's already an active game in this chat
    if (game) {
      const playerSendtags = game.players.map(player => player.sendtag).join(', ');
      const message = await ctx.reply(
        `🎲 The game is on!\n` +
        `First ${game.maxNumber} players\n\n` +
        `Players${game.players.length ? ` (${game.players.length})` : ''}: ${playerSendtags}\n\n` +
        `${game.masterName} is sending it.\n`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '/join', callback_data: 'join_game' }
          ]]
        },
        disable_notification: true
      });
      queueMessageDeletion(ctx, game.messageId)
      queueMessageDeletion(ctx, ctx.message.message_id);
      game.messageId = message.message_id;
      return;
    }

    // Parse the command arguments
    const args = ctx.message.text.split(' ');
    let minNumber = 3;
    let maxNumber = Math.floor(Math.random() * 17) + minNumber; // default (3-20)ult amount
    let amount = "1000";


    if (args[1]) {
      const arg = parseInt(args[1]);
      if (!isNaN(arg)) {
        if (arg >= 500) {
          // If 500 or more, treat as amount
          amount = arg.toString();
        } else if (arg <= 20) {
          // If between 3 and 20, treat as player count
          if (args[2]) {
            const explicitAmount = parseInt(args[2]);
            if (!isNaN(explicitAmount) && explicitAmount >= 500) {
              amount = explicitAmount.toString();
            }
          }
          maxNumber = arg < minNumber ? minNumber : arg;
        }
      }
    }

    // Generate random number between 1 and maxNumber
    const winningNumber = Math.floor(Math.random() * maxNumber) + 1;

    // Send initial message and store its ID
    const message = await ctx.reply(
      `🎲 New game started!\n` +
      `First ${maxNumber} players\n\n` +
      `Players: _ \n\n` +
      `${ctx.from?.first_name} is sending ${amount} SEND\n`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '/join', callback_data: 'join_game' }
        ]]
      },
      disable_notification: true
    });

    // Create new game state for this chat
    activeGames.set(chatId, {
      winningNumber,
      active: true,
      players: [],
      chatId,
      messageId: message.message_id,
      maxNumber,
      amount,
      masterId: ctx.from?.id,
      masterName: ctx.from?.first_name
    });

    // Delete the command message
    queueMessageDeletion(ctx, ctx.message.message_id);

  } catch (error) {
    console.error('Game error:', error);
    try {
      await ctx.reply(
        `❌ Error starting game: Something went wrong.\n` +
        `Please try again later.`,
        { disable_notification: true }
      );
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  }
});

const pendingPlayers = new Map<number, Set<Player>>();
const COLLECTION_WINDOW = 1000; // 1 second window to collect clicks

// Add this near your other handlers
bot.action('join_game', async (ctx) => {
  if (!ctx.chat || !ctx.callbackQuery || !ctx.from) return;

  const chatId = ctx.chat.id;
  const game = activeGames.get(chatId);

  if (!game?.active) {
    await ctx.telegram.answerCbQuery(ctx.callbackQuery.id, 'No active game!');
    return;

  }

  // Parse sendtag from name like in send reply
  const parsedName = ctx.from.first_name?.split('/');
  const hasSendtag = parsedName !== undefined && parsedName.length > 1;
  const cleanSendtag = hasSendtag && parsedName[1].replace(/[^a-zA-Z0-9_]/gu, '').trim();

  if (!hasSendtag || !cleanSendtag) {
    await ctx.telegram.answerCbQuery(ctx.callbackQuery.id, 'Add sendtag to your name!');
    return
  }

  if (!pendingPlayers.has(chatId)) {
    pendingPlayers.set(chatId, new Set());
    // Process after collection window
    setTimeout(async () => {
      try {
        const players = Array.from(pendingPlayers.get(chatId) || []);
        pendingPlayers.delete(chatId);

        // Take first N players
        const availableSlots = game.maxNumber - game.players.length;
        const newPlayers = players.slice(0, availableSlots);
        game.players.push(...newPlayers);

        // Notify players of their position or if they missed out
        await Promise.all(players.map(async (player, index) => {
          const position = game.players.length - newPlayers.length + index + 1;
          try {
            await ctx.telegram.answerCbQuery(
              player.callbackQueryId,
              index < availableSlots
                ? `You're #${position} of ${game.maxNumber} 🎲`
                : `Game filled up! You were #${index + 1} 😢`
            );
          } catch (error) {
            console.error('Error notifying player:', error);
          }
        }));

        // Update game message
        const playerSendtags = game.players.map(player => player.sendtag).join(', ');
        const messageText = `🎲 The game is on!\n` +
          `First ${game.maxNumber} players\n\n` +
          `Players${game.players.length ? ` (${game.players.length})` : ''}: ${playerSendtags}\n\n` +
          `${game.masterName} is sending ${game.amount} SEND.\n`;

        const messageOptions = {
          reply_markup: {
            inline_keyboard: [[
              { text: '/join', callback_data: 'join_game' }
            ]]
          }
        };
        // Update message with retry
        await withRetry(async () => {
          await ctx.telegram.editMessageText(
            chatId,
            game.messageId,
            undefined,
            messageText,
            messageOptions
          );
        });

        // Process winner if game is full
        if (game.players.length >= game.maxNumber) {
          game.active = false;
          const winner = game.players[game.winningNumber - 1];
          const winningRecipient = winner.sendtag.split('/')[1];

          const winnerCommand = {
            recipient: winningRecipient,
            amount: game.amount,
            token: TokenType.SEND
          };

          const url = generateSendUrl(winnerCommand);
          const text = generateGameButtonText(winner.sendtag, game);

          await withRetry(async () => {
            // Delete game state first
            activeGames.delete(chatId);

            // Delete game message
            await queueMessageDeletion(ctx, game.messageId);

            // Send winner message
            await ctx.reply(
              `🎉 Winner\n # ${game.winningNumber}!\n\n${text}`,
              {
                reply_markup: {
                  inline_keyboard: [[{ text: `/send`, url }]]
                }
              }
            );

            await startCooldown(ctx, chatId);
          });
        }
      } catch (error) {
        console.error('Error processing batch:', error);
      }
    }, COLLECTION_WINDOW);
  }
  // Add player to pending set
  if (!game.players.some(p => p.userId === ctx.from.id)) {
    pendingPlayers.get(chatId)?.add({
      sendtag: `/${cleanSendtag}`,
      userId: ctx.from.id,
      callbackQueryId: ctx.callbackQuery.id
    });

    await ctx.telegram.answerCbQuery(
      ctx.callbackQuery.id,
      `Processing...  🎲`
    );
  } else {
    await ctx.telegram.answerCbQuery(ctx.callbackQuery.id, 'Already joined!');
  }
});




bot.on('message', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) return;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  // Delete messages with multiple sendtags that aren't part of URLs
  const urlPattern = /(https?:\/\/[^\s]+)/g;

  // First, remove all URLs from the text for sendtag checking
  let textWithoutUrls = text;
  const urls = text.match(urlPattern) || [];
  urls.forEach(url => {
    textWithoutUrls = textWithoutUrls.replace(url, '');
  });

  // Now check for sendtags in the remaining text
  const sendtagPattern = /\/[a-zA-Z0-9_]+/g;
  const sendtagMatches = textWithoutUrls.match(sendtagPattern);

  if (sendtagMatches && sendtagMatches.length >= 2) {
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  const cooldown = chatCooldowns.get(chatId);



  // Handle cooldown period
  if (cooldown?.active && sendtagMatches) {
    queueMessageDeletion(ctx, ctx.message.message_id);

    const now = Date.now();
    if (now - cooldown.lastUpdate >= 1000 && cooldown.messageId) {
      cooldown.lastUpdate = now;
      try {
        queueMessageDeletion(ctx, cooldown.messageId);
        const cooldownMsg = await ctx.reply(
          `⏳ Sendtag Cooldown (${Math.ceil((cooldown.endTime - Date.now() / 1000))}s)`,
          { parse_mode: 'HTML' }
        );
        cooldown.messageId = cooldownMsg.message_id;
      } catch (error) {
        console.log('Error updating cooldown message:', error);
      }
    }
    return;
  }
  const game = activeGames.get(chatId);
  if (game?.active && sendtagMatches) {
    // If game is active, delete messages with sendtags that aren't in URLs
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }
});

bot.command('kill', async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  let game = activeGames.get(chatId);
  if (game && ctx.from?.id === game.masterId) {
    game.active = false;
    activeGames.delete(chatId);
    await ctx.telegram.editMessageText(
      chatId,
      game.messageId,
      undefined,
      `🎲 Game killed by game master.`
    );
    queueMessageDeletion(ctx, ctx.message.message_id);
    return
  }
})


// Handle errors
bot.catch((err: unknown) => {
  console.error('Bot error:', err);
});

// Start the bot
bot.launch().then(() => {
  console.log('Bot is running...');
}).catch((err) => {
  console.error('Failed to start bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));