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
  useEthAddress?: boolean;
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
    useEthAddress: true,
    decimals: 18n
  }
};

const BASE_URL = 'https://send.app/send/confirm';

interface SendCommand {
  recipient: string;
  amount: string;
  token: TokenType;
}

function parseSendCommand(text: string): SendCommand | null {
  const regex = /^\/send\s+\/(\w+)\s+(\d+)\s+(SEND|USDC|ETH)$/i;
  const match = text.match(regex);

  if (!match) {
    return null;
  }

  return {
    recipient: match[1],
    amount: match[2],
    token: match[3].toUpperCase() as TokenType
  };
}

function generateSendUrl(command: SendCommand): string {
  const params: Record<string, string> = {
    idType: 'tag',
    recipient: command.recipient,
  };

  const tokenConfig = TOKEN_CONFIG[command.token];
  if (tokenConfig.useEthAddress) {
    params.sendAddress = 'eth';
  } else if (tokenConfig.address) {
    params.sendToken = tokenConfig.address;
  }

  params.amount = (BigInt(command.amount) * (1n * 10n ** tokenConfig.decimals)).toString();

  return `${BASE_URL}?${new URLSearchParams(params).toString()}`;
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
      disable_notification: true, // Silent notification
    });

  } catch (error) {
    console.error('Error in sendHiddenMessage:', error);
  }
}

const helpMessage = `
*Available commands:*
\/send \/recipient amount token
\/guess [number] [amount] - Start sendtag guessing game

*Supported tokens:*
• SEND: Send token
• USDC: USDC on Base
• ETH: Ethereum

*Examples:*
\/send \/vic 5555 SEND
\/send \/vic 100 USDC
\/send \/vic 1 ETH
\/guess - Start game with range 1-100
\/guess 10 - Start game with range 1-10'
\/guess 10 1000 - Start game with range 1-10 for 1000 SEND post
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
      const cleanSendtag = hasSendtag && parsedName[1].replace(/[\u{1F300}-\u{1F9FF}]|[\u{2700}-\u{27BF}]|[\u{2600}-\u{26FF}]|[\u{2300}-\u{23FF}]|[\u{1F000}-\u{1F6FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F100}-\u{1F1FF}]|[\u{1F680}-\u{1F6FF}]|[\u{2000}-\u{206F}]|[\u{2190}-\u{21FF}]|[\u{20D0}-\u{20FF}]|[\u{2100}-\u{214F}]|[\u{2B00}-\u{2BFF}]/gu, '').trim();


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
  amount: number;
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
      `🎲 Game ended by game master.`
    );
    return
  }
})

bot.command('guess', async (ctx) => {
  try {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    let game = activeGames.get(chatId);

    // Check if there's already an active game in this chat
    if (game) {
      const message = await ctx.reply(
        `🎲 The guessing game is on! Drop your sendtag to participate.\n` +
        `First ${game.maxNumber} sendtags\n\n` +
        `Entries: ${game.players.toString()}\n\n` +
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
    let maxNumber = Math.floor(Math.random() * 20) + 3; // default
    let amount = 1000;

    if (args.length > 1) {
      const inputNumber = parseInt(args[1]);
      const inputAmount = parseInt(args[2]);
      if (!isNaN(inputNumber) && inputNumber > 3) {
        maxNumber = inputNumber;
      }
      if (!isNaN(inputAmount) && inputAmount > 500) {
        amount = inputAmount;
      }
    }

    // Generate random number between 1 and maxNumber
    const winningNumber = Math.floor(Math.random() * maxNumber) + 1;

    // Send initial message and store its ID
    const message = await ctx.reply(
      `🎲 New game started! Drop your sendtag to participate.\n` +
      `First ${maxNumber} sendtags\n\n` +
      `Entries: \n\n` +
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




bot.hears(/^\/([a-zA-Z0-9_]+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;

  const game = activeGames.get(chatId);
  if (!game?.active) {
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) {
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  // Check if user has already participated in this chat's game
  if (game.players.some(player => player.userId === userId)) {
    queueMessageDeletion(ctx, ctx.message.message_id);
    return;
  }

  const sendtag = ctx.match[1];

  // Queue the entry message for deletion
  queueMessageDeletion(ctx, ctx.message.message_id);

  // Add player to game's players array
  game.players.push({
    sendtag,
    messageId: ctx.message.message_id,
    userId: userId
  });

  // Update the original message with new entry count
  try {
    await ctx.telegram.editMessageText(
      chatId,
      game.messageId,
      undefined,
      `🎲 The guessing game is on! Drop your sendtag to participate.\n` +
      `First ${game.maxNumber} sendtags\n\n` +
      `Entries: ${game.players.toString()}\n\n` +
      "The winner will be posted after the game is over.\n",
    );
  } catch (error) {
    console.log('Error updating message:', error);
  }

  // If this player's index matches the winning number
  if (game.players.length >= game.maxNumber) {
    // Generate send URL for winner
    const winnerCommand: SendCommand = {
      recipient: game.players[game.winningNumber - 1].sendtag,
      amount: game.amount.toString(),
      token: TokenType.SEND
    };

    const sendUrl = generateSendUrl(winnerCommand);

    game.active = false;

    await sendHiddenMessage(ctx,
      `🎉 We have a winner!\n` +
      `Winning number: ${game.winningNumber}\n` +
      `Winner: /${sendtag}\n\n` +
      `${game.masterName} owes you ${game.amount} SEND.\n\n` +
      sendUrl
    );

    queueMessageDeletion(ctx, game.messageId)

    // Remove the finished game
    activeGames.delete(chatId);
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