/** Repository-owned transport fixture ONLY. No prompt interpretation, provider,
 * network, filesystem access, shell, credential reads or child processes. */
const [format, scenario] = process.argv.slice(2);
if (!['codex', 'opencode'].includes(format ?? '') || !['success', 'failure', 'hang', 'ignore-term', 'completed-hang', 'malformed', 'oversized', 'stderr-flood', 'invalid-utf8', 'env-check'].includes(scenario ?? '')) process.exit(2);
if (scenario === 'hang' || scenario === 'ignore-term') {
  if (scenario === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (scenario === 'malformed') process.stdout.write('not JSON\n');
else if (scenario === 'oversized') process.stdout.write('x'.repeat(65537));
else if (scenario === 'stderr-flood') process.stderr.write('x'.repeat(65537));
else if (scenario === 'invalid-utf8') process.stdout.write(Buffer.from([0xc3, 0x0a]));
else if (scenario === 'failure') { process.stderr.write('private-error-must-not-be-returned\n'); process.exitCode = 1; }
else {
  const text = scenario === 'env-check'
    ? JSON.stringify({ inheritedSecret: Boolean(process.env.FORGE_TEST_SECRET), nodeOptions: Boolean(process.env.NODE_OPTIONS), home: Boolean(process.env.HOME), path: Boolean(process.env.PATH) })
    : 'Offline transport 完成';
  const part = (type: string, value: object) => ({ type, sessionID: 'fixture-session', timestamp: 1, part: { id: `part-${type}`, messageID: 'fixture-message', sessionID: 'fixture-session', ...value } });
  const lines = format === 'codex' ? [
    { type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'fixture-item', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } },
  ] : [part('step_start', { type: 'step-start' }), part('text', { type: 'text', text }),
    part('step_finish', { type: 'step-finish', reason: 'stop', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })];
  // Deliberately split UTF-8 and JSON framing across writes, and omit final LF.
  const bytes = Buffer.from(lines.map(line => JSON.stringify(line)).join('\r\n') + (scenario === 'completed-hang' ? '\n' : ''));
  let position = 0;
  const write = () => {
    if (position >= bytes.length) {
      if (scenario === 'completed-hang') setInterval(() => {}, 1000);
      return;
    }
    process.stdout.write(bytes.subarray(position, position += 7));
    setImmediate(write);
  };
  write();
}
