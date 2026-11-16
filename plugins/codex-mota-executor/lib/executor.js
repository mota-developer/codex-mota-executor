import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleCompletion, OutputContractError, parseAgentJson, resultLanguage, usageOrThrow } from './output.js';
import { buildRepairMessage, buildSystemPrompt } from './prompt.js';
import { allowRuntimeContext, scrubTask } from './redact.js';
import { POSITION_TO_SCHEMA } from './schema.js';

export const MAX_REPAIR_ROUNDS = 2;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const PROCESS_SUPERVISOR = fileURLToPath(new URL('./codex-process.js', import.meta.url));
const PASSIVE_ITEMS = new Set(['agent_message', 'reasoning', 'error', 'plan', 'todo_list']);
const DISABLED_FEATURES = [
  'shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2',
  'image_generation', 'view_image', 'sleep_tool', 'goals', 'skill_search',
  'skill_mcp_dependency_install', 'memories', 'request_permissions_tool',
];
const TASK_FIELDS = [
  'runId', 'agentCode', 'positionType', 'schemaVersion', 'templateId', 'templateInputData',
  'taskBrief', 'globalParameters', 'runtimeContext', 'runtimeMetadata', 'upstream',
];
// The CLI handles its own stored login or API key. The worker's environment
// may contain unrelated credentials. Only pass the variables the CLI needs.
const CLI_ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_API_KEY', 'OPENAI_API_KEY',
];

function executionError(code, message, usage) {
  return Object.assign(new Error(message), { code, usage });
}

function findExecutable(command) {
  const candidates = typeof command !== 'string' ? []
    : isAbsolute(command) ? [command]
    : /^[\w.-]+$/.test(command)
      ? (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => resolve(dir, command))
      : [];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Look for the next executable on PATH.
    }
  }
  return null;
}

function runtimeHome(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw executionError('CODEX_PROFILE_REQUIRED', '请配置独立的 Codex CLI 认证目录');
  }
  let home;
  try {
    home = realpathSync(directory);
    if (!statSync(home).isDirectory()) throw new Error();
    accessSync(home, constants.R_OK | constants.X_OK);
  } catch {
    throw executionError('CODEX_PROFILE_REQUIRED', 'Codex CLI 认证目录不存在，请先为此 Worker 登录');
  }
  const usualHome = join(homedir(), '.codex');
  if (home === usualHome || (existsSync(usualHome) && home === realpathSync(usualHome))
      || ['AGENTS.md', 'AGENTS.override.md'].some((file) => existsSync(join(home, file)))) {
    throw executionError('CODEX_PROFILE_REQUIRED', '请使用独立且无全局 AGENTS 指令的 Codex CLI 认证目录');
  }
  return home;
}

function cliArgs(config, instructions) {
  return [
    '--no-daemon', '--ask-for-approval', 'never', 'exec',
    '--json', '--color', 'never', '--ephemeral',
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--strict-config',
    ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--enable', 'skip_host_skill_discovery',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'default_permissions="mota_executor"',
    '-c', 'permissions.mota_executor.filesystem={":minimal"="read"}',
    '-c', 'permissions.mota_executor.network.enabled=false',
    '-c', `developer_instructions=${JSON.stringify(instructions)}`,
    ...(config.model ? ['--model', config.model] : []),
    ...(config.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`] : []),
    '-',
  ];
}

function measuredUsage(raw) {
  if (!raw || raw.input_tokens === undefined || raw.output_tokens === undefined) return undefined;
  const { input_tokens: promptTokens, output_tokens: completionTokens,
    cached_input_tokens: cachedInputTokens, reasoning_output_tokens: reasoningTokens } = raw;
  const totalTokens = promptTokens + completionTokens;
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!nonnegative(promptTokens) || !nonnegative(completionTokens)
      || !Number.isSafeInteger(totalTokens) || totalTokens < 1
      || (cachedInputTokens !== undefined && (!nonnegative(cachedInputTokens) || cachedInputTokens > promptTokens))
      || (reasoningTokens !== undefined && (!nonnegative(reasoningTokens) || reasoningTokens > completionTokens))) {
    throw executionError('RUNTIME_USAGE_INVALID', 'Codex 返回了无效的 Token 用量');
  }
  // Codex counts cached input and reasoning output in their respective
  // totals. The event reports turn totals, not the provider request count.
  return { totalTokens, promptTokens, completionTokens, cachedInputTokens, reasoningTokens };
}

function sumUsage(turns) {
  if (turns.length === 0) return undefined;
  const total = {};
  for (const field of ['totalTokens', 'promptTokens', 'completionTokens', 'cachedInputTokens', 'reasoningTokens']) {
    if (turns.every((turn) => turn[field] !== undefined)) {
      total[field] = turns.reduce((sum, turn) => sum + turn[field], 0);
    }
  }
  return total;
}

function runCodex(executable, config, { cwd, codexHome, instructions, prompt, signal, timeoutMs }) {
  const cancelled = () => executionError('TASK_CANCELLED', '任务已取消或租约已丢失');
  if (signal?.aborted) return Promise.reject(cancelled());
  if (timeoutMs <= 0) return Promise.reject(executionError('TASK_TIMEOUT', 'Codex 执行超时'));
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    return Promise.reject(executionError('TASK_SHAPE_INVALID', '任务输入超出执行器大小上限'));
  }
  const env = Object.fromEntries(CLI_ENV_KEYS.flatMap((key) => (
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []
  )));
  env.CODEX_HOME = codexHome;
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [PROCESS_SUPERVISOR, executable, ...cliArgs(config, instructions)], {
      cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    });
    const owner = child.stdio[3];
    owner.on('error', () => {});
    let buffer = '';
    let bytes = 0;
    let reply = '';
    let usage;
    let completed = false;
    let failed = false;
    let failure;
    let forceKill;
    let settled = false;
    const interrupt = (error) => {
      if (failure) return;
      failure = error;
      owner.destroy();
      // The supervisor should finish killing its process group in one
      // second. Bound the wait even if a descendant kept a pipe open.
      forceKill = setTimeout(() => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
        settle(null);
      }, 1500);
    };
    const onAbort = () => interrupt(cancelled());
    const timer = setTimeout(() => interrupt(executionError('TASK_TIMEOUT', 'Codex 执行超时')), timeoutMs);
    const readEvent = (line) => {
      if (!line.trim() || failure) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        interrupt(executionError('CODEX_PROTOCOL_ERROR', 'Codex 输出不是有效的 JSON Lines'));
        return;
      }
      if (event?.item && !PASSIVE_ITEMS.has(event.item.type)) {
        interrupt(executionError('CODEX_TOOL_ACTIVITY', 'Codex 返回了预期之外的工具活动'));
        return;
      }
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (typeof event.item.text === 'string') reply = event.item.text;
      } else if (event?.type === 'turn.completed') {
        if (completed) {
          interrupt(executionError('CODEX_PROTOCOL_ERROR', 'Codex 返回了多个结束事件'));
          return;
        }
        completed = true;
        try {
          usage = measuredUsage(event.usage);
        } catch (error) {
          interrupt(error);
        }
      } else if (event?.type === 'turn.failed') {
        failed = true;
      }
      // Individual error events can be transient (for example transport
      // fallback). The process exit status and terminal turn event decide.
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => {
      failure ??= executionError('CODEX_START_FAILED', '无法启动 Codex CLI，请检查可执行文件路径');
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_EVENT_BYTES) {
        interrupt(executionError('CODEX_PROTOCOL_ERROR', 'Codex 输出超过限制'));
        return;
      }
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      for (const line of lines) readEvent(line);
    });
    function settle(status) {
      if (settled) return;
      settled = true;
      readEvent(buffer);
      clearTimeout(timer);
      clearTimeout(forceKill);
      owner.destroy();
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(Object.assign(failure, { usage }));
      else if (status === 125 && !completed) {
        reject(executionError('CODEX_START_FAILED', '无法启动 Codex CLI，请检查可执行文件路径'));
      } else if (status !== 0 || failed || !completed) {
        reject(executionError('CODEX_RUN_FAILED', 'Codex 未完成，请检查 CLI 登录、模型权限和网络', usage));
      } else if (!usage) {
        reject(executionError('RUNTIME_USAGE_MISSING', 'Codex 未提供真实 Token 用量'));
      } else resolveRun({ reply, usage });
    }
    child.on('close', settle);
    // A startup failure may close stdin before it is fully written.
    child.stdin.on('error', () => {});
    if (signal?.aborted) onAbort();
    child.stdin.end(prompt);
  });
}

const genericProbeFixture = {
  runtimeContext: { isFinal: false },
  taskBrief: '本地自检。模拟组合无持仓、无开放订单、无上游、无标的、无市场观测，也无风控指标观测。请按岗位契约回报无可执行动作；若为风控岗位，缺失的观测按 UNKNOWN 处理。只用这些模拟事实。',
};

function portfolioProbeFixtures() {
  const context = {
    observedAt: Date.parse('2026-01-02T15:00:00Z'),
    account: { totalAssets: 1000, netLiquidation: 1000, cashBalance: 500, currency: 'USD' },
    positions: [{ symbol: 'MOTASIM', market: 'US', marketValue: 500, quantity: 10, currency: 'USD' }],
    todayOrders: [],
  };
  return [
    {
      globalParameters: { targetMarkets: ['US'] },
      runtimeContext: { ...context, isFinal: false },
      taskBrief: '本地过程阶段自检。MOTASIM 是虚构标的。输入只用于验证契约：无交易动作，按观察到的当前持仓维持配置，给出非空 target_allocation，说明依据。',
    },
    {
      globalParameters: { targetMarkets: ['US'] },
      runtimeContext: { ...context, isFinal: true },
      taskBrief: '本地终局阶段自检。MOTASIM 是虚构标的。维持模拟组合现状，无交易动作；返回空 orders、执行报告，并以已给的观测时间作为报告时间。',
    },
  ];
}

export class TaskExecutor {
  constructor({ config = {} } = {}) {
    this.config = config;
  }

  ready() {
    try {
      runtimeHome(this.config.codexHome);
      const executable = findExecutable(this.config.codexPath ?? 'codex');
      return executable ? { ok: true, reason: null }
        : { ok: false, reason: '未找到 Codex CLI，请配置 codexPath' };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  async execute({ connection, task, signal, timeoutMs = (this.config.taskTimeoutSeconds ?? 600) * 1000 }) {
    const positionType = connection.positionType;
    if (!Object.hasOwn(POSITION_TO_SCHEMA, positionType)
        || (task?.positionType != null && task.positionType !== positionType)
        || typeof task?.agentCode !== 'string' || task.agentCode !== connection.agentCode) {
      throw executionError('TASK_IDENTITY_INVALID', '任务的 Agent Code 或岗位与当前绑定不一致');
    }
    if (!Array.isArray(task?.templateInputData)) {
      throw executionError('TASK_SHAPE_INVALID', 'templateInputData 缺失或不是数组');
    }
    const executable = findExecutable(this.config.codexPath ?? 'codex');
    if (!executable) throw executionError('CODEX_START_FAILED', '未找到 Codex CLI，请配置 codexPath');
    const codexHome = runtimeHome(this.config.codexHome);
    const language = resultLanguage(task, this.config.language);
    const safeTask = scrubTask(Object.fromEntries(TASK_FIELDS.map((key) => [key, task[key]])), [connection.token]);
    safeTask.positionType = positionType;
    safeTask.runtimeContext = allowRuntimeContext(safeTask.runtimeContext);
    const isFinal = safeTask.runtimeContext?.isFinal;
    const instructions = buildSystemPrompt(positionType, { language, isFinal });
    const taskPrompt = `请根据下列任务数据按岗位契约输出 JSON。岗位职责和任务安全规则以开发者指令为准。\n${JSON.stringify(safeTask)}`;
    const deadline = performance.now() + timeoutMs;
    const cwd = await mkdtemp(join(tmpdir(), 'codex-mota-task-'));
    const turns = [];
    try {
      let prompt = taskPrompt;
      for (let round = 0; round <= MAX_REPAIR_ROUNDS; round += 1) {
        const result = await runCodex(executable, this.config, {
          cwd, codexHome, instructions, prompt, signal, timeoutMs: Math.floor(deadline - performance.now()),
        });
        turns.push(result.usage);
        if (signal?.aborted) throw executionError('TASK_CANCELLED', '任务已取消或租约已丢失');
        try {
          const business = scrubTask(parseAgentJson(result.reply), [connection.token]);
          const envelope = assembleCompletion(positionType, business, sumUsage(turns), language, { isFinal });
          return { envelope, business, usage: envelope.usage };
        } catch (error) {
          if (!(error instanceof OutputContractError)) throw error;
          if (round === MAX_REPAIR_ROUNDS) {
            // Validator details may quote private task values. Send them only
            // back to this model for repair, never to the worker's diagnostics.
            throw executionError('OUTPUT_CONTRACT_INVALID', 'Codex 返回的结果未通过岗位输出契约');
          }
          const problems = error.problems.slice(0, 12).map((problem) => problem.slice(0, 400));
          // Each repair is a fresh ephemeral CLI turn with the full task
          // context. Do not depend on a persisted Codex conversation.
          prompt = `${taskPrompt}\n\n${buildRepairMessage(problems)}`;
        }
      }
    } catch (error) {
      if (error.usage) turns.push(error.usage);
      error.usage = sumUsage(turns);
      throw error;
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  async probe({ connection, signal, timeoutMs }) {
    const started = performance.now();
    const isPortfolioManager = connection.positionType === 'PORTFOLIO_MANAGER';
    const deadline = started + (timeoutMs ?? (isPortfolioManager ? 120_000 : 60_000));
    try {
      const synthetic = { agentCode: 'local-self-check', positionType: connection.positionType };
      const usageByStage = [];
      for (const fixture of isPortfolioManager ? portfolioProbeFixtures() : [genericProbeFixture]) {
        const { usage } = await this.execute({
          connection: synthetic, signal, timeoutMs: Math.floor(deadline - performance.now()),
          task: {
            ...synthetic,
            runId: 'local-self-check',
            schemaVersion: '1.0',
            templateInputData: [],
            ...fixture,
          },
        });
        usageByStage.push(usage);
      }
      const usage = usageOrThrow(sumUsage(usageByStage));
      return { pass: true, latencyMs: Math.round(performance.now() - started), error: null, usage };
    } catch (error) {
      return {
        pass: false, latencyMs: Math.round(performance.now() - started),
        error: error.code ?? 'CODEX_SELFCHECK_FAILED',
      };
    }
  }
}
