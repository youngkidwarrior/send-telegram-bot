import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import { Message, MessageEntity, Update } from 'telegraf/types';

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

interface CommandMessage extends Message.TextMessage {
  text: string;
  entities?: MessageEntity[];  // Command entities will always exist
}

type CommandContext = Context<Update.MessageUpdate<CommandMessage>>;
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

// Add at the top with other interfaces
interface DeleteTask {
  chatId: number;
  messageId: number;
}

// Add with other global variables
const deleteQueue: DeleteTask[] = [];
let isProcessingQueue = false;

// Add this new function to handle deletions
async function queueMessageDeletion(ctx: Context | CommandContext, messageId: number) {
  if (!ctx.chat) return;

  try {
    const isCommand = ctx?.message && ('entities' in ctx.message) && ctx.message.entities?.some(entity => entity.type === 'bot_command' && entity.offset === 0);
    // Check if message is from an admin
    if (ctx.from && !ctx.from.is_bot && !isCommand) {

      const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
      if (['administrator', 'creator'].includes(member.status)) {
        return; // Don't delete admin messages
      }
    }

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
  catch (error) {
    console.log('Error checking admin status:', error);
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


interface SendCommand {
  recipient: string;
  amount?: string;
  token?: TokenType;
  note?: string;
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

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Help command
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
SendBot only works if your sendtag is in your name
*/send*
• Reply with /send
  • /send /vic
  • /send /vic 100
• Send a token
  • /send /vic 10 USDC
• Write a note
  • /send /vic 100 > This is a note
  • /send /vic 100
    This is a note


*/guess*
• /guess - Random slots, 1000 SEND prize
• /guess 2000 - Random slots, 2000 SEND prize
• /guess 10 2000 - 10 slots, 2000 SEND prize
• /kill - End your game
`;

// Handle /help command
bot.command('help', async (ctx) => {
  await sendMessage(ctx, helpMessage);
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Send command
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}


function textToQuotedMarkdown(note: string | undefined): string | undefined {
  if (!note || note === '') return undefined;
  return note
    .split('\n')
    .map(line => {
      // Escape special characters for MarkdownV2
      const escapedLine = line.replace(/([_*[\]()~`#+\-=|{}.!\\])/g, '\\$1')
      return `     >${escapedLine}`;
    })
    .join('\n');
}

function generateSendText(ctx: CommandContext, recipient: string, amount?: string, token?: TokenType, note?: string): string {

  const markdownSender = ctx.from.first_name
  const markdownRecipient = escapeMarkdown(recipient);
  const repliedToUser = ctx.message.reply_to_message?.from;
  const formattedNote = note ? `📝 Note from ${markdownSender}:\n\n${textToQuotedMarkdown(note)}` : '';

  return amount ?
    `${formattedNote}\n\n➡️ ${markdownSender} is sending ${amount} ${token ?? 'SEND'
    } to / ${markdownRecipient} ` + (repliedToUser ? `[‎](tg://user?id=${repliedToUser.id})` : '') :
    `${formattedNote}\n\n➡️ ${markdownSender} is sending to /${markdownRecipient} ` + (repliedToUser ? `[‎](tg://user?id=${repliedToUser.id})` : '');
}


function parseSendNote(text: string): { command: string, note?: string } {
  // Try newline first
  const newlineIndex = text.indexOf('\n');
  const carrotIndex = text.indexOf('>');
  if (newlineIndex === -1 && carrotIndex === -1) {
    return { command: text };
  }
  const splitIndex = (newlineIndex === -1) ? carrotIndex :
    (carrotIndex === -1) ? newlineIndex :
      Math.min(newlineIndex, carrotIndex);
  return {
    command: text.slice(0, splitIndex),
    note: text.slice(splitIndex + 1).trim() || undefined
  };
}

function parseSendCommand(ctx: CommandContext): SendCommand | undefined {
  // Split command and note
  const { command, note } = parseSendNote(ctx.message.text);
  // Remove /send and trim to parse the rest
  const content = command.slice(5).trim();

  // Match patterns in specific order
  const patterns = {
    sendtag: /\/([a-zA-Z0-9_]+)/,      // Must start with /
    amount: /(\d[\d,]*(?:\.\d+)?)/,    // number format supports commas and decimals
    token: /(SEND|USDC|ETH)(?:\s+|$)/i  // More lenient token match
  };
  const sendtagMatch = content.match(patterns.sendtag);
  const isReply = ctx?.message?.reply_to_message;
  if (!isReply && !sendtagMatch?.[1]) {
    return;
  }

  const repliedToUser = ctx?.message?.reply_to_message?.from;
  const isReplyToSelf = repliedToUser?.id === ctx.message.from.id;

  if (isReplyToSelf) {
    return;
  }

  const params: SendCommand = {
    recipient: "",
  };

  if (isReply) {
    const parsedName = repliedToUser?.first_name?.split('/');
    const hasSendtag = parsedName !== undefined && parsedName.length > 1
    const cleanSendtag = hasSendtag && parsedName[1].split(/[\s\u{1F300}-\u{1F9FF}]/u)[0].replace(/[^a-zA-Z0-9_]/gu, '').trim();
    if (!cleanSendtag || cleanSendtag === '') {
      return;
    }
    params.recipient = cleanSendtag;
  } else if (sendtagMatch?.[1]) {
    params.recipient = sendtagMatch[1];
  }

  if (params.recipient === "") {
    return;
  }
  // add back the /. Would be better to do this in recipient but might break stuff
  const senderTag = "/" + params.recipient
  const afterSendtag = content.slice(content.indexOf(senderTag) + senderTag.length);
  const amountMatch = afterSendtag.match(patterns.amount);
  if (amountMatch?.[1]) {
    const cleanAmount = amountMatch[1].replace(/,/g, '');
    params.amount = cleanAmount;
  }

  // Extract token - search after amount if exists
  const tokenMatch = afterSendtag.match(patterns.token);
  if (tokenMatch?.[1]) {
    params.token = tokenMatch[1].toUpperCase() as TokenType;
  }

  if (note) {
    params.note = note;
  }

  return params;
}


// Handle /send command
bot.command('send', async (ctx: CommandContext) => {
  if (!ctx.chat) {
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  const parsedCommand = parseSendCommand(ctx);
  if (parsedCommand) {
    const url = generateSendUrl(parsedCommand);
    const text = generateSendText(
      ctx,
      parsedCommand.recipient,
      parsedCommand.amount,
      parsedCommand.token,
      parsedCommand.note
    );

    await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: [[
          { text: '/send', url }
        ]]
      },
      parse_mode: 'MarkdownV2',
      reply_parameters: ctx.message.reply_to_message ? {
        message_id: ctx.message.reply_to_message.message_id,
        allow_sending_without_reply: true
      } : undefined,
    });
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  queueMessageDeletion(ctx, ctx.message.message_id);
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Guess command
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////



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

function generateGameButtonText(winner: Player, game: GameState): string {
  return `➡️ [‎](tg://user?id=${game.masterId}) ${game.masterName} send ${game.amount} to ${winner.sendtag} [‎](tg://user?id=${winner.userId})`
}

bot.command('guess', async (ctx) => {
  try {
    if (!ctx.chat || Boolean(ctx.message.reply_to_message)) return;
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
        if (game.players.length < game.maxNumber) {
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
        }
        // Process winner if game is full
        if (game.players.length >= game.maxNumber) {
          const deletedGame = activeGames.get(chatId);
          activeGames.delete(chatId);
          if (deletedGame?.active) {
            const winner = game.players[game.winningNumber - 1];
            const winningRecipient = winner.sendtag.split('/')[1];

            const winnerCommand = {
              recipient: winningRecipient,
              amount: game.amount,
              token: TokenType.SEND
            };

            const url = generateSendUrl(winnerCommand);
            const text = generateGameButtonText(winner, game);

            await withRetry(async () => {

              // Delete game message
              await queueMessageDeletion(ctx, game.messageId);

              // Send winner message
              await ctx.reply(
                `🎉 Winner\n # ${game.winningNumber} out of ${game.maxNumber}!\n\n${text}`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[{ text: `/send`, url }]]
                  }
                }
              );

              await startCooldown(ctx, chatId);
            });
          }
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