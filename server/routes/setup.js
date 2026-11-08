import express from 'express';
import config from '../config.js';
import logger from '../utils/logger.js';
import * as install from '../install.js';
import * as users from '../users/store.js';
import { verifyClaudeKey, looksLikeClaudeKey } from '../llm/verify.js';
import { resetClient } from '../llm/client.js';
import { connectAppPassword, overBudget, parseAppPasswordForm } from './auth.js';
import { createBackup, openBackup, restoreBackup } from '../backup.js';

/**
 * The first-run screen and the household, for app-password installs.
 *
 * Public: the setup steps (guarded by the one-time setup code) and reading an
 * invite before accepting it. Behind sign-in and the PIN: everything the owner
 * manages afterwards (householdRouter).
 */
const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const refuse = (res, status, error, field) => res.status(status).json({ error, ...(field && { field }) });

/** Checks the code (with a budget, since each guess is cheap) before anything else. */
function codeProblem(req) {
  if (overBudget(`setup:${req.ip}`)) return [429, 'Too many tries. Wait a few minutes, then try again.'];
  if (!install.checkSetupCode(req.body?.code)) {
    return [400, "That setup code isn't right. It's shown where the app was started (in its log), and it's 8 digits.", 'code'];
  }
  return null;
}

async function keyProblem(apiKey) {
  if (!looksLikeClaudeKey(apiKey)) return [400, 'A Claude API key starts with sk-ant-. Copy it from the Claude console.', 'apiKey'];
  const check = await verifyClaudeKey(apiKey);
  if (check.ok === false) return [400, check.reason, 'apiKey'];
  if (check.ok === null) logger.warn(`Saving a Claude key that could not be checked: ${check.reason}`);
  return null;
}

router.get('/setup', asyncRoute(async (req, res) => {
  res.json({ needed: await install.setupNeeded(), needsKey: install.needsClaudeKey() });
}));

/** Step 1 and 2 of the first run: the setup code, then the Claude key. Saves nothing. */
router.post('/setup/check', asyncRoute(async (req, res) => {
  if (!(await install.setupNeeded())) return refuse(res, 409, 'This app is already set up. Sign in instead.');
  const bad = codeProblem(req);
  if (bad) return refuse(res, ...bad);
  if (req.body?.apiKey !== undefined && install.needsClaudeKey()) {
    const badKey = await keyProblem(String(req.body.apiKey).trim());
    if (badKey) return refuse(res, ...badKey);
  }
  res.json({ ok: true, needsKey: install.needsClaudeKey() });
}));

/**
 * The last step: connects the owner's Gmail and finishes setup in one go, so a
 * half-finished setup never leaves an install claimed without an owner.
 */
router.post('/setup/claim', asyncRoute(async (req, res) => {
  if (!(await install.setupNeeded())) return refuse(res, 409, 'This app is already set up. Sign in instead.');
  const bad = codeProblem(req);
  if (bad) return refuse(res, ...bad);

  const apiKey = install.needsClaudeKey() ? String(req.body?.apiKey || '').trim() : null;
  if (install.needsClaudeKey()) {
    const badKey = await keyProblem(apiKey);
    if (badKey) return refuse(res, ...badKey);
  }

  const form = parseAppPasswordForm(req.body);
  if (form.error) return refuse(res, 400, form.error, form.field);

  const result = await connectAppPassword(req, res, form, {
    afterSave: (account) => {
      install.completeSetup({ ownerId: account.id, anthropicKey: apiKey });
      resetClient();
    },
    patch: { role: 'owner' },
  });
  if (result.ok) logger.info(`Set up: ${result.account.id} is the owner`);
}));

/**
 * Restoring a backup onto a fresh install, instead of setting it up anew: the
 * setup code proves this is the person who started it, the passphrase opens
 * the file. The file is sent as the raw body (it can be larger than any JSON
 * request), the code and passphrase in headers.
 */
router.post('/setup/restore', express.raw({ type: 'application/octet-stream', limit: '200mb' }), asyncRoute(async (req, res) => {
  if (!(await install.setupNeeded())) return refuse(res, 409, 'This app is already set up. A backup can only be restored onto a new one.');
  const bad = codeProblem({ ip: req.ip, body: { code: req.get('x-setup-code') } });
  if (bad) return refuse(res, ...bad);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return refuse(res, 400, 'Choose the backup file.', 'file');

  try {
    const payload = await openBackup(req.body.toString('utf8'), req.get('x-backup-passphrase') || '');
    const summary = restoreBackup(payload);
    users.forgetCache();
    install.load();
    resetClient();
    logger.info(`Restored a backup: ${summary.accounts} account(s), ${summary.ledgers} ledger(s)`);
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (err.status) return refuse(res, err.status, err.message, err.field);
    throw err;
  }
}));

/** What an invite link says before it's accepted. */
router.get('/invites/:token', asyncRoute(async (req, res) => {
  const invite = install.findInvite(req.params.token);
  if (!invite) return res.json({ valid: false });
  const from = await users.getUser(invite.createdBy);
  res.json({ valid: true, from: from?.name?.split(/\s+/)[0] || null, product: config.product.name });
}));

/* ---------- the household, once signed in ---------- */

export const householdRouter = express.Router();

async function requireOwner(req, res, next) {
  if (await install.isOwner(req.account.id)) return next();
  return refuse(res, 403, 'Only the person who set this app up can do that.');
}

householdRouter.get('/household', asyncRoute(async (req, res) => {
  const owner = await install.ownerId();
  const isOwner = owner === req.account.id;
  const members = (await users.listUsers())
    .filter((u) => u.status === 'active')
    .sort((a, b) => (Date.parse(a.createdAt || '') || Infinity) - (Date.parse(b.createdAt || '') || Infinity))
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name || null,
      joinedAt: u.createdAt || null,
      owner: u.id === owner,
      you: u.id === req.account.id,
    }));
  res.json({
    members,
    isOwner,
    invites: isOwner ? install.listInvites() : [],
    // Ledgers on this machine are worth a backup; ones in Drive are already safe.
    canBackup: isOwner && config.mail.access === 'app-password',
    claude: {
      provider: config.ai.provider,
      key: config.ai.provider === 'anthropic' ? install.claudeKeyHint() : null,
      changeable: isOwner && config.ai.provider === 'anthropic' && install.keySetInApp(),
    },
  });
}));

householdRouter.post('/household/invites', requireOwner, asyncRoute(async (req, res) => {
  const invite = install.createInvite(req.account.id);
  logger.info(`Invite ${invite.id} created by ${req.account.id}`);
  res.status(201).json({ id: invite.id, path: `/join/${invite.token}`, expiresAt: invite.expiresAt });
}));

householdRouter.delete('/household/invites/:id', requireOwner, asyncRoute(async (req, res) => {
  install.cancelInvite(req.params.id);
  res.json({ ok: true });
}));

/** Stops someone's access. Their ledger file stays in the data folder. */
householdRouter.delete('/household/members/:id', requireOwner, asyncRoute(async (req, res) => {
  if (req.params.id === req.account.id) return refuse(res, 400, "You can't remove yourself. Delete your account from You instead.");
  const member = await users.getUser(req.params.id);
  if (!member || member.status !== 'active') return refuse(res, 404, 'No such member.');
  await users.saveUser(member.id, { status: 'removed', removedAt: new Date().toISOString(), removedBy: req.account.id });
  logger.info(`Member ${member.id} removed by ${req.account.id}`);
  res.json({ ok: true });
}));

/** The whole install in one encrypted file, for safekeeping or moving host. */
householdRouter.post('/household/backup', requireOwner, asyncRoute(async (req, res) => {
  if (config.mail.access !== 'app-password') {
    return refuse(res, 404, "Each person's ledger is already in their own Google Drive.");
  }
  try {
    const backup = await createBackup(req.body?.passphrase);
    logger.info(`Backup made by ${req.account.id}`, backup.summary);
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${backup.filename}"`);
    res.set('Cache-Control', 'no-store');
    res.send(backup.content);
  } catch (err) {
    if (err.status) return refuse(res, err.status, err.message);
    throw err;
  }
}));

householdRouter.put('/household/claude-key', requireOwner, asyncRoute(async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  const bad = await keyProblem(apiKey);
  if (bad) return refuse(res, ...bad);
  install.setClaudeKey(apiKey);
  resetClient();
  logger.info(`Claude key changed by ${req.account.id}`);
  res.json({ ok: true, key: install.claudeKeyHint() });
}));

export default router;
