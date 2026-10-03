#!/usr/bin/env python3
"""Run every TIM hook command a host config holds, verbatim, with a PATH that has no node and no tim."""
import json, subprocess, sys, tomllib, pathlib
home = pathlib.Path.home(); demo = home / 'demo'
tr = home / 'transcript.jsonl'
tr.write_text('\n'.join(json.dumps(x) for x in [
  {"type": "user", "uuid": "u1", "message": {"role": "user", "content": "Which database do we use for the store?"}},
  {"type": "assistant", "uuid": "a1", "message": {"role": "assistant", "content": [{"type": "text", "text": "SQLite, decided for local simplicity."}]}},
]) + '\n')
env = {'HOME': str(home), 'PATH': '/usr/bin:/bin'}
fails = 0
def run(label, cmd, payload, as_arg=False):
    global fails
    if isinstance(cmd, list):
        p = subprocess.run(cmd + [payload], capture_output=True, text=True, env=env, cwd=demo)
    else:
        p = subprocess.run(['sh', '-c', cmd], input=payload, capture_output=True, text=True, env=env, cwd=demo)
    ok = p.returncode == 0 and not p.stderr.strip()
    fails += not ok
    print(f"[{'OK ' if ok else 'BAD'}] {label}: exit={p.returncode} stdout={p.stdout[:120]!r} stderr={p.stderr[:300]!r}")
host = sys.argv[1]
base = {"session_id": f"sbx-{host}", "transcript_path": str(tr), "cwd": str(demo)}
if host == 'claude':
    s = json.loads((home / '.claude/settings.json').read_text())
    for ev in ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']:
        for g in s.get('hooks', {}).get(ev, []):
            for h in g['hooks']:
                if 'tim' in h['command']:
                    run(f"{ev} :: {h['command']}", h['command'], json.dumps(dict(base, hook_event_name=ev, source='startup', prompt='Which database?', reason='exit')))
elif host == 'codex':
    cfg = tomllib.loads((home / '.codex/config.toml').read_text())
    if cfg.get('notify'):
        run('notify', cfg['notify'], json.dumps({"type": "agent-turn-complete", "thread-id": "sbx-codex", "turn-id": "t1", "cwd": str(demo), "input-messages": ["Which database?"], "last-assistant-message": "SQLite."}))
    for g in json.loads((home / '.codex/hooks.json').read_text()).get('hooks', {}).get('SessionStart', []):
        for h in g['hooks']:
            run(f"SessionStart :: {h['command']}", h['command'], json.dumps(dict(base, session_id='sbx-codex', hook_event_name='SessionStart', source='startup')))
elif host == 'cursor':
    for ev, items in json.loads((home / '.cursor/hooks.json').read_text()).get('hooks', {}).items():
        for h in items:
            run(f"{ev} :: {h['command']}", h['command'], json.dumps({"conversation_id": "sbx-cursor", "generation_id": "g1", "hook_event_name": ev, "cwd": str(demo), "transcript_path": str(tr)}))
print(f"{host} hooks: {'ALL OK' if not fails else f'{fails} FAILED'}")
