import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import { Message, MessageEntity, Update, User } from 'telegraf/types';
import { ErrorSchema, Profile, ProfileResponseSchema } from './zod';

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
    address: '0xEab49138BA2Ea6dd776220fE26b7b8E446638956',
    decimals: 18n
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

const MIN_GUESS_AMOUNT = 50;
const SURGE_COOLDOWN = 60000; // 1 minute in milliseconds
const SURGE_INCREASE = 50; // Amount to increase by each time

const sendApiUrl = process.env.SEND_API_URL ?? ''
const sendApiKey = process.env.SEND_SUPABASE_API_KEY ?? ''
const sendApiVersion = process.env.SEND_API_VERSION ?? 'v1'


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Fetch
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
async function fetchProfile(sendtag: string): Promise<Profile | "InvalidTag" | null> {
  const sendProfileLookupUrl = `${sendApiUrl}/rest/${sendApiVersion}/rpc/profile_lookup`
  const response = await fetch(sendProfileLookupUrl, {
    method: 'POST',
    headers: {
      'apikey': sendApiKey ?? "",
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      lookup_type: 'tag',
      identifier: sendtag
    })
  });

  if (!response.ok) {
    const status = response.status;
    if (status === 400 || status === 401) {
      console.error('Invalid API key');
      return null
    }
    console.error('Error fetching profile:', response.statusText);
  }

  const data = await response.json();


  // First try to parse as error response
  const errorResult = ErrorSchema.safeParse(data);
  if (errorResult.success) {
    if (errorResult.data.code === "P0001") {
      return "InvalidTag";
    }
  }

  // Then try to parse as profile response
  const parsed = ProfileResponseSchema.safeParse(data);
  if (!parsed.success) {
    return null
  }

  const profile = parsed.data[0];
  if (!profile) {
    return 'InvalidTag';
  }

  return profile;
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Admin Cacheing
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Cache storage
const adminCache = new Map<number, {
  ids: number[],
  timestamp: number
}>();

const CACHE_TIMEOUT = 60 * 60 * 1000; // 1 hour in ms

// Function to get admin IDs with caching
async function getAdminIds(ctx: Context | CommandContext, chatId: number): Promise<number[]> {
  const now = Date.now();
  const cached = adminCache.get(chatId);

  // Return cached value if still valid
  if (cached && now - cached.timestamp < CACHE_TIMEOUT) {
    return cached.ids;
  }

  // Fetch new admin list
  // This includes both admins and creator
  try {

    const admins = await ctx.telegram.getChatAdministrators(chatId);
    const adminIds = admins.map(admin => admin.user.id);

    // Update cache
    adminCache.set(chatId, {
      ids: adminIds,
      timestamp: now
    });

    return adminIds;
  } catch (error) {
    console.error('Error getting admins:', error);
    return cached?.ids || []; // Return cached ids if available, empty array if not
  }
}

function cleanupAdminCache() {
  const now = Date.now();
  for (const [chatId, data] of adminCache.entries()) {
    if (now - data.timestamp > CACHE_TIMEOUT) {
      adminCache.delete(chatId);
    }
  }
}

// Run cleanup every hour
setInterval(cleanupAdminCache, CACHE_TIMEOUT);


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Message Deletion
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
  const chatId = ctx.chat.id;

  const isBotMessage = ctx.message?.from?.id === bot.botInfo?.id;
  try {
    const isCommand = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim().startsWith('/') : false;
    // Check if message is from an admin
    if (ctx.message && !isBotMessage && !isCommand) {
      const adminIds = await getAdminIds(ctx, chatId);
      const isAdmin = adminIds.includes(ctx.message.from.id);
      if (isAdmin) {
        return; // Don't delete admin messages
      }
    }

    const task = { chatId, messageId };

    // If it's our bot's message, prioritize it
    if (isBotMessage) {
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
    // Process in batches of 10
    const batch = deleteQueue.splice(0, 10);

    try {
      await withRetry(async () => {
        await bot.telegram.deleteMessages(
          batch[0].chatId,
          batch.map(task => task.messageId)
        );
      });
      await sleep(100); // Small delay between batches
    } catch (error: any) {
      // If batch delete fails, try individual deletes as fallback
      for (const task of batch) {
        try {
          await bot.telegram.deleteMessage(task.chatId, task.messageId);
        } catch (error: any) {
          if (!error?.response?.description?.includes("message can't be deleted") &&
            !error?.response?.description?.includes("message to delete not found")) {
            console.log('Error deleting message:', {
              error: error?.message,
              description: error?.response?.description,
              chatId: task.chatId,
              messageId: task.messageId
            });
          }
        }
      }
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
      parse_mode: 'MarkdownV2',
      disable_notification: true, // Silent notification
    });

  } catch (error) {
    console.error('Error in sendMessage:', error);
  }
}

const helpMessage = `
*SendBot* only works if your sendtag is in your name

*/send*
Send SEND tokens
\`/send /vic 30 SEND\`

*Send with note*
\`/send /vic 30 > Hello!\`

*Send as reply*
\`/send 30 > Hello!\`

*Games*
• /guess \\- Random slots, ${MIN_GUESS_AMOUNT} SEND minimum
• /guess 50 \\- Random slots, 50 SEND prize
• /guess 10 50 \\- 10 slots, 50 SEND prize
• /kill \\- End your game

*Send Surge* 1 minute cooldown
\`/guess \\- ${MIN_GUESS_AMOUNT} SEND minimum
/guess \\- ${MIN_GUESS_AMOUNT + SURGE_INCREASE} SEND minimum
/guess \\- ${MIN_GUESS_AMOUNT + (SURGE_INCREASE * 2)} SEND minimum\``;

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


function escapeMarkdownText(text: string | undefined): string | undefined {
  if (!text || text === '') return undefined;
  return text
    .split('\n')
    .map(line => {
      // Escape special characters for MarkdownV2
      const escapedLine = line.replace(/[_*[\]()~`#+\-=|{}.!]/g, '\\$&');
      return `${escapedLine}`;
    })
    .join('\n');
}

function wrapText(text: string, maxWidth: number = 28): string {
  // Split into words and keep line breaks
  const words = text.split(' ');
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    // Check if adding the next word (plus a space) would exceed maxWidth
    if ((currentLine + ' ' + word).length <= maxWidth) {
      currentLine += ' ' + word;  // Add to current line
    } else {
      lines.push(currentLine);    // Save current line
      currentLine = word;         // Start new line with word
    }
  }
  lines.push(currentLine);  // Don't forget the last line

  return lines.join('\n');
}

function generateSendText(ctx: CommandContext, recipient: string, amount?: string, token?: TokenType, note?: string): string {
  const markdownSender = escapeMarkdown(ctx.from.first_name);
  const markdownRecipient = escapeMarkdown(recipient);
  const markdownNote = escapeMarkdownText(note);
  const formattedNote = markdownNote ? wrapText(markdownNote) : undefined;
  const repliedToUser = ctx.message.reply_to_message?.from;
  const formattedAmount = amount ? Number(amount).toLocaleString('en-US') : undefined;
  const rightPadding = ' '.repeat(Math.max(28 - markdownSender.length - 8, 0)); // 8 for "sent by "
  const headerText = `\`\n┃ \`` + (formattedAmount ? `*${formattedAmount} ${token ?? 'SEND'} to /${markdownRecipient}*` : `*${markdownSender} sending to /${markdownRecipient}*`);
  const noteText = formattedNote ?
    `\`\n┃\` \`━━━━━━━━━━\n┃\` ${formattedNote.split('\n').join('\n┃ ')}\`\n┃\`` : "";
  const senderText = formattedAmount ?
    `\`\n┃\` ${rightPadding}\`sent by ${markdownSender}\`` : "";
  const replyText = repliedToUser?.id ?
    `[‎](tg://user?id=${repliedToUser.id})` : '';


  return headerText + noteText + senderText + replyText;
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
  const textToSearch = isReply ? content : afterSendtag;
  const amountMatch = textToSearch.match(patterns.amount);
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
  players: Player[];
  chatId: number;
  messageId: number;
  maxNumber: number;
  amount: string;
  master: User
}

// Track games by chat ID
let activeGames: Map<number, GameState> = new Map();

function generateGameButtonText(winner: Player, game: GameState, surgeData?: SurgeData): string {
  const surgeAmount = surgeData?.multiplier ? surgeData.multiplier * SURGE_INCREASE : 0;
  const amount = Number(game.amount);
  const surgeAdded = amount - surgeAmount < 0 ? 0 : amount - surgeAmount;

  const surgeText = surgeAdded > 0 ?
    `+ ${surgeAdded.toLocaleString()} SEND during Send Surge` : '';

  const escapedMasterName = game.master.first_name.replace(/_/g, '\\_');
  const escapedSendtag = winner.sendtag.replace(/_/g, '\\_');

  return `➡️ [‎](tg://user?id=${game.master.id}) ${escapedMasterName} send ${Number(game.amount).toLocaleString()} SEND to ${escapedSendtag} [‎](tg://user?id=${winner.userId})\n\n${surgeText}`
}

interface SurgeData {
  lastTimestamp: number;
  multiplier: number;
}
const chatSurgeData = new Map<number, SurgeData>();

bot.command('guess', async (ctx) => {
  try {
    if (!ctx.chat || Boolean(ctx.message.reply_to_message)) return;

    const chatId = ctx.chat.id;
    const currentTime = Date.now();

    // Get or initialize surge data for this chat
    let surgeData = chatSurgeData.get(chatId) || { lastTimestamp: 0, multiplier: 0 };
    let game = activeGames.get(chatId);

    // Only increment surge if there's no active game
    if (!game && currentTime - surgeData.lastTimestamp < SURGE_COOLDOWN) {
      surgeData.multiplier++;
    } else if (game) {
      // Keep existing surge if game is active
      surgeData = chatSurgeData.get(chatId) || { lastTimestamp: 0, multiplier: 0 };
    } else {
      surgeData.multiplier = 0;
    }
    surgeData.lastTimestamp = currentTime;
    chatSurgeData.set(chatId, surgeData);
    const currentMinAmount = MIN_GUESS_AMOUNT + (surgeData.multiplier * SURGE_INCREASE);

    let cooldown = chatCooldowns.get(chatId);
    if (cooldown?.active) {
      cooldown.messageId && queueMessageDeletion(ctx, cooldown.messageId);
      cooldown.active = false;
    }

    // Check if there's already an active game in this chat
    if (game) {
      const playerSendtags = game.players.map(player => player.sendtag).join(', ');
      const formattedAmount = Number(game.amount).toLocaleString('en-US');
      const message = await ctx.reply(
        `${game.master.first_name} is sending ${formattedAmount} SEND\n` +
        `${game.players.length}/${game.maxNumber} players` +
        `\n\n${playerSendtags}` +
        `${(surgeData?.multiplier ?? 0) > 0 ? `\n📈 Send Surge: ${surgeData.multiplier}` : ''}`, {
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
    let maxNumber = Math.floor(Math.random() * 17) + minNumber; // default (3-20)
    let amount = currentMinAmount.toString();

    if (args[1]) {
      const arg = parseInt(args[1]);
      if (!isNaN(arg)) {
        if (arg >= currentMinAmount) {
          // If currentMinAmount or more, treat as amount
          amount = arg.toString();
        } else if (arg <= 20) {
          // If between 3 and 20, treat as player count
          if (args[2]) {
            const explicitAmount = parseInt(args[2]);
            if (!isNaN(explicitAmount) && explicitAmount >= currentMinAmount) {
              amount = explicitAmount.toString();
            }
          }
          maxNumber = arg < minNumber ? minNumber : arg;
        }
      }
    }

    // Generate random number between 1 and maxNumber
    const winningNumber = Math.floor(Math.random() * maxNumber) + 1;
    const formattedAmount = Number(amount).toLocaleString('en-US');
    const surgeMultiplier = surgeData.multiplier

    // Send initial message and store its ID
    const message = await ctx.reply(
      `${ctx.from?.first_name} is sending ${formattedAmount} SEND\n` +
      `${maxNumber} players` +
      `\n\n` +
      `${(surgeMultiplier ?? 0) > 0 ? `\n📈 Send Surge: ${surgeMultiplier}` : ''}`, {
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
      players: [],
      chatId,
      messageId: message.message_id,
      maxNumber,
      amount,
      master: ctx.from
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


bot.action('join_game', async (ctx) => {
  if (!ctx.chat || !ctx.callbackQuery || !ctx.from) return;

  const chatId = ctx.chat.id;
  const game = activeGames.get(chatId);

  if (!game) {
    await ctx.telegram.answerCbQuery(ctx.callbackQuery.id, 'No active game!');
    return;

  }
  const surgeData = chatSurgeData.get(chatId);

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

        // Deduplicate players based on userId
        const uniquePlayers = players.filter((player, index, self) =>
          index === self.findIndex(p => p.userId === player.userId)
        );

        // Take first N unique players
        const availableSlots = game.maxNumber - game.players.length;
        const newPlayers = uniquePlayers.slice(0, availableSlots);
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
          const formattedAmount = Number(game.amount).toLocaleString('en-US');
          const messageText = `${game.master.first_name} is sending ${formattedAmount} SEND\n` +
            `${game.players.length}/${game.maxNumber} players` +
            `\n\n${playerSendtags}` +
            `${(surgeData?.multiplier ?? 0) > 0 ? `\n📈 Send Surge: ${surgeData?.multiplier}` : ''}`


          const messageOptions = {
            reply_markup: {
              inline_keyboard: [[
                { text: '/join', callback_data: 'join_game' }
              ]]
            }
          };
          // Update message with retry
          if (game) {
            try {
              await withRetry(async () => {
                await ctx.telegram.editMessageText(
                  chatId,
                  game.messageId,
                  undefined,
                  messageText,
                  messageOptions
                );
              });
            } catch (error) {
              // Log but don't throw - game might have completed
              console.log('Edit failed, game may have completed:', error);
            }
          }
        }
        // Process winner if game is full
        if (game.players.length >= game.maxNumber) {
          const deletedGame = activeGames.get(chatId);
          const isDeleted = activeGames.delete(chatId);
          if (isDeleted) {
            let winner = game.players[game.winningNumber - 1];
            let winningRecipient = winner.sendtag.split('/')[1];
            let profile = await fetchProfile(winningRecipient);
            if (profile === "InvalidTag") {
              let winningNumber = Math.floor(Math.random() * game.maxNumber) + 1
              winner = game.players[winningNumber - 1];
              winningRecipient = winner.sendtag.split('/')[1];
              // pick one new winner for now to make it simple
              profile = await fetchProfile(winningRecipient);
            }
            if (!profile || profile === "InvalidTag") {
              profile = null
            }

            const winnerCommand = {
              recipient: winningRecipient,
              amount: game.amount,
              token: TokenType.SEND
            };

            const url = generateSendUrl(winnerCommand);
            const basescanUrl = `https://basescan.org/token/${TOKEN_CONFIG.SEND.address}?a=${profile?.address}`;
            const text = generateGameButtonText(winner, game, surgeData);

            await withRetry(async () => {
              if (!isDeleted) {
                return;
              }

              // Delete game message
              await queueMessageDeletion(ctx, game.messageId);

              const inline_keyboard = [
                [{ text: `/send`, url }]
              ];
              if (profile !== null) {
                inline_keyboard.push([{ text: `Basescan 🔗`, url: basescanUrl }]);
              }

              // Send winner message
              await ctx.reply(
                `🎉 Winner\n # ${game.winningNumber} out of ${game.maxNumber}!\n\n${text}`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard
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
  const isPending = Array.from(pendingPlayers.get(chatId) || []).some(p => p.userId === ctx.from.id);

  // Add player to pending set
  if (!game.players.some(p => p.userId === ctx.from.id) && !isPending) {
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

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Kill command
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

bot.command('kill', async (ctx: CommandContext) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  let game = activeGames.get(chatId);

  if (!game) {
    // No game to kill - just delete command and return
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  // Check if user is admin or game master
  try {
    const isGameMaster = ctx.message.from.id === game.master.id;
    const adminIds = await getAdminIds(ctx, chatId);
    const isAdmin = adminIds.includes(ctx.message.from.id);

    if (!isAdmin && !isGameMaster) {
      queueMessageDeletion(ctx, ctx.message.message_id);
      return;
    }
    const isDeleted = activeGames.delete(chatId);

    // First edit the message to show game is killed
    if (isDeleted && game.messageId) {
      try {
        await withRetry(async () => {
          await ctx.telegram.editMessageText(
            chatId,
            game.messageId,
            undefined,
            `🎲 Game killed by ${isAdmin ? "Admin" : ctx.from?.first_name}`,
          );
        });
      } catch (error) {
        // Ignore edit errors - message might be gone
        console.log('Failed to edit game message:', error);
      }
    }

    queueMessageDeletion(ctx, ctx.message.message_id)


  } catch (error) {
    console.log('Error in kill command:', error);
    queueMessageDeletion(ctx, ctx.message.message_id);
  }
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Spam Management
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

bot.on('message', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message) || ctx.from?.is_bot) return;
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
  if (Boolean(game) && sendtagMatches) {
    // If game is active, delete messages with sendtags that aren't in URLs
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }
});



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Bot Upstart
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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