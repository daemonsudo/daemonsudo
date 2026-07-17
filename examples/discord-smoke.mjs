#!/usr/bin/env node
// Discord smoke test — the Stage 7 "Bun gate" (run on Bun FIRST, then Node).
// discord.js on Bun is the one genuine platform risk of v0.3; if this fails
// on Bun, the recorded contingency is a raw Gateway WebSocket client, NOT a
// Node-only channel.
//
// Full mode (needs a real bot):
//   GATE_DISCORD_TOKEN=... GATE_DISCORD_SMOKE_USER=<your user id> \
//     bun examples/discord-smoke.mjs   (then click the button in the DM)
//
// Credential-free mode (default): exercises the same stack without an
// account — library import + client construction, a REAL gateway WebSocket
// handshake (HELLO op 10 arrives tokenless), and a REST auth round-trip
// (invalid token must produce Discord's TokenInvalid error, proving the
// request reached Discord through the ws/undici layers this runtime ships).
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const ok = (msg) => console.log(`✓ [${runtime}] ${msg}`);
const fail = (msg) => {
  console.error(`✗ [${runtime}] ${msg}`);
  process.exit(1);
};

function makeClient() {
  return new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });
}

// 1. Library loads and a client (with button builders) constructs.
const probeClient = makeClient();
new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("a:x:y").setLabel("Approve").setStyle(ButtonStyle.Success),
);
ok("discord.js imported; Client + ActionRow/Button builders construct");

const token = process.env.GATE_DISCORD_TOKEN;
const smokeUser = process.env.GATE_DISCORD_SMOKE_USER;

if (!token) {
  // 2. Real gateway WebSocket handshake: HELLO (op 10) arrives without auth.
  const { WebSocket } = await import("ws"); // the same ws discord.js rides on
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no HELLO within 15s")), 15_000);
    const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.op === 10) {
        clearTimeout(t);
        ws.close();
        resolve();
      }
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  }).catch((e) => fail(`gateway WebSocket handshake failed: ${e.message}`));
  ok("gateway WebSocket handshake — HELLO (op 10) received over the ws package");

  // 3. REST auth round-trip: an invalid token must be REJECTED BY DISCORD
  //    (TokenInvalid), proving the REST stack works end-to-end here.
  try {
    await probeClient.login("invalid-token-for-smoke");
    fail("login with an invalid token unexpectedly succeeded");
  } catch (e) {
    if (/token/i.test(String(e?.code ?? e?.message))) {
      ok(`REST reached Discord and rejected the bad token (${e.code ?? e.message})`);
    } else {
      fail(`REST layer error was not Discord's token rejection: ${e?.stack ?? e}`);
    }
  }
  probeClient.destroy();
  console.log(`SMOKE PASS (credential-free) on ${runtime} — set GATE_DISCORD_TOKEN + GATE_DISCORD_SMOKE_USER for the full DM/button flow`);
  process.exit(0);
}

// Full mode: login, DM a card with one button, wait for the click.
if (!smokeUser) fail("GATE_DISCORD_TOKEN is set but GATE_DISCORD_SMOKE_USER is not");
const client = makeClient();
client.once("clientReady", async () => {
  ok(`logged in as ${client.user.tag}`);
  const user = await client.users.fetch(smokeUser);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("smoke:ack").setLabel("✅ Click me").setStyle(ButtonStyle.Success),
  );
  await user.send({ content: `daemonsudo discord smoke (${runtime}) — click the button`, components: [row] });
  ok("DM card sent — waiting up to 120s for the button click");
});
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== "smoke:ack") return;
  await interaction.update({ content: `smoke acknowledged on ${runtime} ✓`, components: [] });
  ok("button interaction received and acknowledged");
  console.log(`SMOKE PASS (full) on ${runtime}`);
  client.destroy();
  process.exit(0);
});
setTimeout(() => fail("no button interaction within 120s"), 120_000);
await client.login(token);
