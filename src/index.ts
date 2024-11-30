import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import { game } from 'telegraf/typings/button';

dotenv.config();

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
    amount: /\d{1,3}(?:,\d{3})*(?:\.\d+)?/,         // Ensure it's a valid number format
    token: /\s+(SEND|USDC|ETH)(?:\s+|$)/i  // Must have space before token
  };

  const sendtagMatch = content.match(patterns.sendtag);
  if (!sendtagMatch?.[1]) {
    return null;
  }

  const params: SendCommand = {
    recipient: sendtagMatch[1],
  }

  const amountMatch = content.match(patterns.amount);
  if (amountMatch?.[1]) {
    params.amount = amountMatch[1];
  }

  const tokenMatch = content.match(patterns.token);
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
      const cleanSendtag = hasSendtag && parsedName[1].replace(/[^a-zA-Z0-9_]/gu, '').trim();

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
        const patterns = {
          amount: /\d{1,3}(?:,\d{3})*(?:\.\d+)?/, // Must have spaces around number
          token: /\s+(SEND|USDC|ETH)(?:\s+|$)/i  // Must have space before token
        };

        const amountMatch = content.match(patterns.amount);
        const tokenMatch = content.match(patterns.token);

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

// Add these at the top with other interfaces
interface Player {
  sendtag: string;
  userId: number;
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
      await bot.telegram.deleteMessage(task.chatId, task.messageId);
      // Add small delay between deletions to prevent rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      console.log('Error deleting message:', error);
    }
  }

  isProcessingQueue = false;
}

// Track games by chat ID
let activeGames: Map<number, GameState> = new Map();

// Add with other global variables
const chatCooldowns: Map<number, {
  active: boolean,
  messageId?: number,
  lastUpdate: number,
  endTime: number,
}> = new Map();

async function startCooldown(ctx: Context, chatId: number) {
  const endTime = Math.floor(Date.now() / 1000) + 45;

  try {
    // Send cooldown message
    const cooldownMsg = await ctx.reply(
      `⏳ Sendtag Cooldown: 45 sec`,
      { disable_notification: true }
    );

    const cooldown = {
      active: true,
      messageId: cooldownMsg.message_id,
      lastUpdate: Date.now(),
      endTime: endTime,
    };
    chatCooldowns.set(chatId, cooldown);

    // Clear after 1 minute
    setTimeout(() => {
      const cooldown = chatCooldowns.get(chatId)
      chatCooldowns.delete(chatId)
      if (cooldown?.messageId) {
        queueMessageDeletion(ctx, cooldown.messageId);
      }
    }, 30000);

  } catch (error) {
    console.error('Error starting cooldown:', error);
  }
}

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
      playerSendtags = game.players.map(player => player.sendtag).join(', ');
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
    let minNumber = 1;
    let maxNumber = Math.floor(Math.random() * 20) + minNumber; // default
    let amount = args[2] ?? "1000";


    if (!isNaN(parseInt(args[1]))) {
      maxNumber = Math.max(minNumber, Math.min(parseInt(args[1]), 20));
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

// Add this near your other handlers
bot.action('join_game', async (ctx) => {
  if (!ctx.chat || !ctx.callbackQuery || !ctx.from) return;

  const chatId = ctx.chat.id;
  const game = activeGames.get(chatId);

  if (!game?.active) return;


  // Check if user already participated
  if (game.players.some(player => player.userId === ctx.from.id)) return;


  // Parse sendtag from name like in send reply
  const parsedName = ctx.from.first_name?.split('/');
  const hasSendtag = parsedName !== undefined && parsedName.length > 1;
  const cleanSendtag = hasSendtag && parsedName[1].replace(/[^a-zA-Z0-9_]/gu, '').trim();

  if (!hasSendtag || !cleanSendtag) return;


  // Add player to game
  if (game.players.length < game.maxNumber) {
    game.players.push({
      sendtag: `/${cleanSendtag}`,
      userId: ctx.from.id
    });

    // Update game message
    const playerSendtags = game.players.map(player => player.sendtag).join(', ');
    await ctx.editMessageText(
      `🎲 The game is on!\n` +
      `First ${game.maxNumber} players\n\n` +
      `Players${game.players.length ? ` (${game.players.length})` : ''}: ${playerSendtags}\n\n` +
      `${game.masterName} is sending ${game.amount} SEND.\n`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '/join', callback_data: 'join_game' }
        ]]
      }
    });

    // Handle game completion if needed
    if (game.players.length >= game.maxNumber) {
      const winningSendtag = game.players[game.winningNumber - 1].sendtag;
      const winningRecipient = winningSendtag.split('/')[1];

      const winnerCommand: SendCommand = {
        recipient: winningRecipient,
        amount: game.amount,
        token: TokenType.SEND
      };

      // When a game winner is chosen
      const url = generateSendUrl(winnerCommand);
      const text = generateGameButtonText(winningSendtag, game);


      await ctx.reply(
        `🎉 Winner\n # ${game.winningNumber}!\n\n` +
        text, {
        reply_markup: {
          inline_keyboard: [[
            { text: `/send`, url }
          ]]
        },
        disable_notification: true
      });

      queueMessageDeletion(ctx, game.messageId);
      game.active = false;
      activeGames.delete(chatId);
      await startCooldown(ctx, chatId);

    }
  }
});


bot.on('message', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) return;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  // Delete messages with multiple sendtags
  const sendtagMatches = text.match(/\/[a-zA-Z0-9_]+/g);
  if (sendtagMatches && sendtagMatches.length >= 2) {
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }


  const cooldown = chatCooldowns.get(chatId);

  // Regex patterns
  const anySendtagRegex = /\/[a-zA-Z0-9_]+/;

  // Handle cooldown period
  if (cooldown?.active && anySendtagRegex.test(text)) {
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
  if (game?.active) {
    const sendtagMatches = text.match(/\/[a-zA-Z0-9_]+/g);
    if (sendtagMatches && sendtagMatches.length < 2) {
      queueMessageDeletion(ctx, ctx.message.message_id);
      return;
    }
  }
});


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