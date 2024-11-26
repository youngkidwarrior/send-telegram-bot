import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';

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

  // Match each part
  const sendtagMatch = content.match(/\/(\w+)/);         // matches /vic
  const amountMatch = content.match(/([,\d.]+)/);        // matches 100, 1,000, 0.5
  const tokenMatch = content.match(/(SEND|USDC|ETH)/i);

  if (!sendtagMatch?.[1]) {
    return null;
  }

  const params: SendCommand = {
    recipient: sendtagMatch[1],
  }

  if (amountMatch?.[1]) {
    params.amount = amountMatch[1];
  }

  if (tokenMatch?.[1]) {
    params.token = tokenMatch[1].toUpperCase() as TokenType;
  }

  return params;

}



function generateSendUrl(command: SendCommand): string | null {
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
  const regularUrl = `${baseUrl}?${new URLSearchParams(params).toString()}`;

  return `[\u200E](${regularUrl})`; // Using explicit Unicode LRM character;
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

async function sendHiddenMessage(ctx: Context, text: string) {
  try {
    // Delete the original command message if possible
    ctx.message && deleteMessage(ctx, ctx.message.message_id);

    // Send the response as a self-destructing message
    return await ctx.reply(text, {
      parse_mode: 'Markdown',
      disable_notification: true, // Silent notification
    });

  } catch (error) {
    console.error('Error in sendHiddenMessage:', error);
  }
}

const helpMessage = `
*/send*
To create a /send link, reply to someone's message with /send or use "/send /sendtag amount token"

Examples:
• Reply to someone with /send to get their payment link
• /send /vic 100 SEND - Send 100 SEND to vic
• /send /vic 50 USDC - Send 50 USDC to vic
• /send /vic 0.1 ETH - Send 0.1 ETH to vic

Supported tokens: SEND, USDC, ETH

*/guess*
Start a fun lottery game where players enter their sendtags to win SEND tokens!

Examples:
• /guess - Start random game (3-20 slots, 1000 SEND prize)
• /guess 10 - Start game with 10 slots
• /guess 10 2000 - Start game with 10 slots and 2000 SEND prize
• /kill - End your game (only game master)

How it works:
• Players enter their sendtags (e.g. /vic)
• When all slots are filled, a random winner is chosen
• Game creator sends SEND tokens to the winner
`;


// Handle /help command
bot.command('help', async (ctx) => {
  await sendHiddenMessage(ctx, helpMessage);
});

// Handle /send command
bot.command('send', async (ctx) => {
  const parsedCommand = parseSendCommand(ctx.message.text);
  if (parsedCommand) {
    const sendUrl = generateSendUrl(parsedCommand);
    await sendHiddenMessage(ctx, `${ctx.message.text}\n\n${sendUrl}`);
    return;
  }

  if (ctx.message.reply_to_message) {
    const repliedToUser = ctx.message.reply_to_message.from;
    const isReplyToSelf = repliedToUser?.id === ctx.message.from.id;

    // Check all available user properties
    if (repliedToUser && !isReplyToSelf) {
      const parsedName = repliedToUser.first_name?.split('/');
      const hasSendtag = parsedName !== undefined && parsedName.length > 1
      const cleanSendtag = hasSendtag && parsedName[1].replace(/[^a-zA-Z0-9_]/gu, '').trim();


      if (hasSendtag) {
        sendHiddenMessage(ctx, `${repliedToUser.first_name}\n\n${"https://send.app/send?idType=tag&recipient=" + cleanSendtag}`);
        return;
      }
    }
  }

  deleteMessage(ctx, ctx.message.message_id);

});

// Add these at the top with other interfaces
interface Player {
  sendtag: string;
  messageId: number;
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

  deleteQueue.push({
    chatId: ctx.chat.id,
    messageId: messageId
  });

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
  const endTime = Math.floor(Date.now() / 1000) + 30;

  try {
    // Send cooldown message
    const cooldownMsg = await ctx.reply(
      `⏳ Sendtag Cooldown: 30 sec`,
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
      const playerSendtags = game.players.map(player => player.sendtag).join(', ');
      const message = await ctx.reply(
        `🎲 The game is on! Drop your sendtag to participate.\n` +
        `First ${game.maxNumber} sendtags\n\n` +
        `Players: ${playerSendtags}\n\n` +
        "The winner will be posted after the game is over.\n",
        { disable_notification: true }
      );
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
      `🎲 New game started! Drop your sendtag to participate.\n` +
      `First ${maxNumber} sendtags\n\n` +
      `Players: _ \n\n` +
      "The winner will be posted after the game is over.\n",
      { disable_notification: true }
    );

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
    deleteMessage(ctx, ctx.message.message_id);

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


bot.on('message', async (ctx) => {
  if (!ctx.chat || !('text' in ctx.message)) return;
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  const cooldown = chatCooldowns.get(chatId);
  const game = activeGames.get(chatId);

  // Regex patterns
  const anySendtagRegex = /\/[a-zA-Z0-9_]+/;
  const exactSendtagRegex = /^\/([a-zA-Z0-9_]+)$/;

  // Handle cooldown period
  if (cooldown?.active && anySendtagRegex.test(text)) {
    queueMessageDeletion(ctx, ctx.message.message_id);

    const now = Date.now();
    if (now - cooldown.lastUpdate >= 500 && cooldown.messageId) {
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

  // Handle game entries
  if (game?.active && exactSendtagRegex.test(text)) {
    const match = text.match(exactSendtagRegex);
    if (!match) return;

    const userId = ctx.from?.id;
    if (!userId) {
      queueMessageDeletion(ctx, ctx.message.message_id);
      return;
    }

    // Check if user already participated
    if (game.players.some(player => player.userId === userId)) {
      queueMessageDeletion(ctx, ctx.message.message_id);
      return;
    }

    const sendtag = `/${match[1]}`;
    queueMessageDeletion(ctx, ctx.message.message_id);

    // Add player to game
    if (game.players.length < game.maxNumber) {
      game.players.push({
        sendtag,
        messageId: ctx.message.message_id,
        userId: userId
      });
    }

    // Update game message
    try {
      const playerSendtags = game.players.map(player => player.sendtag).join(', ');
      await ctx.telegram.editMessageText(
        chatId,
        game.messageId,
        undefined,
        `🎲 The game is on! Drop your sendtag to participate.\n` +
        `First ${game.maxNumber} sendtags\n\n` +
        `Players: ${playerSendtags}\n\n` +
        "The winner will be posted after the game is over.\n",
      );
    } catch (error) {
      console.log('Error updating message:', error);
    }

    // Handle game completion
    if (game.players.length >= game.maxNumber) {
      const winningSendtag = game.players[game.winningNumber - 1].sendtag;
      const winningRecipient = winningSendtag.split('/')[1];

      const winnerCommand: SendCommand = {
        recipient: winningRecipient,
        amount: game.amount,
        token: TokenType.SEND
      };

      const sendUrl = generateSendUrl(winnerCommand);

      await sendHiddenMessage(ctx,
        `🎉 We have a winner!\n` +
        `Winning number: ${game.winningNumber}\n` +
        `Winner: ${winningSendtag}\n\n` +
        `${game.masterName} /send ${winningSendtag} ${game.amount} SEND.\n\n` +
        sendUrl
      );

      queueMessageDeletion(ctx, game.messageId);
      game.active = false;
      activeGames.delete(chatId);
      await startCooldown(ctx, chatId);
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