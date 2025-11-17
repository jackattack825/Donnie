const path = require("path");
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  InteractionType,
  ApplicationCommandOptionType
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");

// -------------------------
// CONFIG
// -------------------------

const BOT_TOKEN = "";

// permanent owner of Donald
const OWNER_ID = "190200434487459842";

// default targets
const DEFAULT_TARGET_IDS = [OWNER_ID];

// slash registration: global=false (fast updates)
const USE_GLOBAL_SLASH = false;

const AUDIO_FILE = path.join(__dirname, "donald_yell.mp3");
const TARGETS_FILE = path.join(__dirname, "donald_targets.json");
const ADMINS_FILE = path.join(__dirname, "donald_admins.json");

// -------------------------
// WEEKLY LOGGING
// -------------------------

function getWeekKey() {
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const dayMs = 24 * 60 * 60 * 1000;
  const dayOfYear = Math.floor((d - oneJan) / dayMs) + 1;
  const week = Math.ceil((dayOfYear + oneJan.getDay()) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getLogFileName() {
  return path.join(__dirname, `donald_log_${getWeekKey()}.txt`);
}

let logStream = fs.createWriteStream(getLogFileName(), { flags: "a" });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  logStream.write(line);
}

process.on("beforeExit", () => {
  log("Process exiting, closing log stream.");
  logStream.end();
});

// -------------------------
// LOAD/SAVE
// -------------------------

function loadTargets() {
  try {
    if (fs.existsSync(TARGETS_FILE)) {
      return JSON.parse(fs.readFileSync(TARGETS_FILE, "utf8")).users || [...DEFAULT_TARGET_IDS];
    }
  } catch {}
  return [...DEFAULT_TARGET_IDS];
}

function saveTargets(set) {
  fs.writeFileSync(TARGETS_FILE, JSON.stringify({ users: [...set] }, null, 2));
}

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8"));
      const admins = parsed.admins || [OWNER_ID];
      if (!admins.includes(OWNER_ID)) admins.push(OWNER_ID);
      return admins;
    }
  } catch {}
  return [OWNER_ID];
}

function saveAdmins(set) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify({ admins: [...set] }, null, 2));
}

// -------------------------
// STATE
// -------------------------

const targetUsers = new Set(loadTargets());
const adminUsers = new Set(loadAdmins());
adminUsers.add(OWNER_ID);

const enabledGuilds = new Set();
const audioPlayer = createAudioPlayer();
const cooldown = new Map();
const wiredConnections = new Set();

// -------------------------
// PERMISSIONS
// -------------------------

const isOwner = (id) => id === OWNER_ID;
const isAdmin = (id) => adminUsers.has(id);

// -------------------------
// DISCORD CLIENT + SHADOW MODE
// -------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  presence: {
    status: "invisible"  // ← SHADOW MODE: always appear offline
  }
});

// -------------------------
// SPEAKING DETECTION
// -------------------------

function wireSpeakingListener(connection, guildId) {
  if (wiredConnections.has(guildId)) return;
  wiredConnections.add(guildId);

  connection.receiver.speaking.on("start", (userId) => {
    if (!targetUsers.has(userId)) return;

    log(`Target ${userId} started speaking.`);

    if (cooldown.has(userId)) return;
    cooldown.set(userId, true);
    setTimeout(() => cooldown.delete(userId), 5000);

    const resource = createAudioResource(AUDIO_FILE);
    audioPlayer.play(resource);
    connection.subscribe(audioPlayer);

    log(`Played yell for ${userId}`);
  });
}

// -------------------------
// VOICE CONNECTION MGMT
// -------------------------

async function ensureConnectionForChannel(channel) {
  const guildId = channel.guild.id;
  let connection = getVoiceConnection(guildId);

  if (connection && connection.joinConfig.channelId !== channel.id) {
    connection.destroy();
    wiredConnections.delete(guildId);
    connection = null;
  }

  if (!connection) {
    log(`Joining VC: ${channel.name}`);

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      log("Voice connect error: " + err);
      return null;
    }
  }

  wireSpeakingListener(connection, guildId);
  return connection;
}

// -------------------------
// SLASH COMMAND HANDLERS
// -------------------------

async function handleArm(interaction) {
  const guild = interaction.guild;

  enabledGuilds.add(guild.id);
  log(`ARM in guild ${guild.id} by ${interaction.user.tag}`);

  for (const id of targetUsers) {
    try {
      const member = await guild.members.fetch(id);
      if (member.voice.channel) {
        await ensureConnectionForChannel(member.voice.channel);
        break;
      }
    } catch {}
  }

  return interaction.reply({ content: "Donald is now ARMED.", ephemeral: true });
}

async function handleDisarm(interaction) {
  const guild = interaction.guild;

  enabledGuilds.delete(guild.id);
  log(`DISARM in guild ${guild.id} by ${interaction.user.tag}`);

  const existing = getVoiceConnection(guild.id);
  if (existing) {
    existing.destroy();
    wiredConnections.delete(guild.id);
  }

  return interaction.reply({ content: "Donald is now DISARMED.", ephemeral: true });
}

async function handleStatus(interaction) {
  const guild = interaction.guild;
  const armed = enabledGuilds.has(guild.id);

  return interaction.reply({
    content:
      `**Status:** ${armed ? "ARMED" : "DISARMED"}\n` +
      `**Targets:** ${[...targetUsers].map(id => `<@${id}>`).join(", ") || "None"}\n` +
      `**Admins:** ${[...adminUsers].map(id => `<@${id}>`).join(", ") || "None"}`,
    ephemeral: true
  });
}

async function handleAddTarget(interaction) {
  const user = interaction.options.getUser("user");

  targetUsers.add(user.id);
  saveTargets(targetUsers);

  log(`Add target ${user.id} by ${interaction.user.tag}`);

  return interaction.reply({
    content: `Added <@${user.id}> as a target.`,
    ephemeral: true
  });
}

async function handleRemoveTarget(interaction) {
  const user = interaction.options.getUser("user");

  if (!targetUsers.has(user.id)) {
    return interaction.reply({ content: "User is not a target.", ephemeral: true });
  }

  targetUsers.delete(user.id);
  saveTargets(targetUsers);

  log(`Remove target ${user.id} by ${interaction.user.tag}`);

  return interaction.reply({
    content: `Removed <@${user.id}> from targets.`,
    ephemeral: true
  });
}

async function handleAddAdmin(interaction) {
  const user = interaction.options.getUser("user");

  adminUsers.add(user.id);
  saveAdmins(adminUsers);

  log(`Add admin ${user.id} by OWNER`);

  return interaction.reply({
    content: `Added <@${user.id}> as admin.`,
    ephemeral: true
  });
}

async function handleRemoveAdmin(interaction) {
  const user = interaction.options.getUser("user");

  if (user.id === OWNER_ID) {
    return interaction.reply({ content: "Cannot remove the owner.", ephemeral: true });
  }

  adminUsers.delete(user.id);
  saveAdmins(adminUsers);

  log(`Remove admin ${user.id} by OWNER`);

  return interaction.reply({
    content: `Removed <@${user.id}> as admin.`,
    ephemeral: true
  });
}

// -------------------------
// VOICE FOLLOWING
// -------------------------

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!enabledGuilds.has(newState.guild.id)) return;
  if (!targetUsers.has(newState.id)) return;

  const newCh = newState.channel;

  if (!newCh) {
    const c = getVoiceConnection(newState.guild.id);
    if (c) {
      c.destroy();
      wiredConnections.delete(newState.guild.id);
    }
    return;
  }

  await ensureConnectionForChannel(newCh);
});

// -------------------------
// SLASH COMMAND REGISTRATION
// -------------------------

client.once("ready", async () => {
  log(`Logged in as ${client.user.tag} (Shadow Mode Active)`);

  // force invisible presence
  client.user.setStatus("invisible");

  const commands = [
    { name: "arm", description: "Arm Donald in this server" },
    { name: "disarm", description: "Disarm Donald in this server" },
    { name: "donald-status", description: "Show Donald's status" },

    {
      name: "donald-add",
      description: "Add a target user",
      options: [
        {
          name: "user",
          description: "User to add",
          type: ApplicationCommandOptionType.User,
          required: true,
        }
      ]
    },

    {
      name: "donald-remove",
      description: "Remove a target user",
      options: [
        {
          name: "user",
          description: "User to remove",
          type: ApplicationCommandOptionType.User,
          required: true,
        }
      ]
    },

    {
      name: "donald-admin-add",
      description: "OWNER ONLY: Add a Donald admin",
      options: [
        {
          name: "user",
          description: "User to grant admin",
          type: ApplicationCommandOptionType.User,
          required: true,
        }
      ]
    },

    {
      name: "donald-admin-remove",
      description: "OWNER ONLY: Remove a Donald admin",
      options: [
        {
          name: "user",
          description: "User to remove",
          type: ApplicationCommandOptionType.User,
          required: true,
        }
      ]
    }
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  if (USE_GLOBAL_SLASH) {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    log("Registered GLOBAL slash commands.");
  } else {
    const guilds = await client.guilds.fetch();
    for (const [id] of guilds) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, id),
        { body: commands }
      );
      log(`Registered slash commands for guild ${id}.`);
    }
  }
});

// -------------------------
// SLASH ROUTER
// -------------------------

client.on("interactionCreate", async (interaction) => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;
  if (!interaction.guild) return;

  const cmd = interaction.commandName;
  const user = interaction.user.id;

  // owner controls
  if (cmd.startsWith("donald-admin-")) {
    if (!isOwner(user)) {
      return interaction.reply({ content: "Only the owner may do that.", ephemeral: true });
    }
    if (cmd === "donald-admin-add") return handleAddAdmin(interaction);
    if (cmd === "donald-admin-remove") return handleRemoveAdmin(interaction);
  }

  // admin controls
  if (!isAdmin(user)) {
    return interaction.reply({ content: "You are not authorized.", ephemeral: true });
  }

  if (cmd === "arm") return handleArm(interaction);
  if (cmd === "disarm") return handleDisarm(interaction);
  if (cmd === "donald-status") return handleStatus(interaction);
  if (cmd === "donald-add") return handleAddTarget(interaction);
  if (cmd === "donald-remove") return handleRemoveTarget(interaction);
});

// -------------------------
// LOGIN
// -------------------------

client.login(BOT_TOKEN);
