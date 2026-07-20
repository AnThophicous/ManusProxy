import fs from 'fs';
import path from 'path';

const dir = 'capture';
const files = fs.readdirSync(dir).filter((x) => x.startsWith('ui-send')).sort();
const f = files[files.length - 1];
if (!f) {
  console.log('no ui-send');
  process.exit(1);
}
const caps = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Array<{
  path: string;
  status?: number;
  reqBody: string | null;
  resBody?: string;
}>;

for (const c of caps) {
  if (!/GetSession|ListSessions|UpdateRead|Create|Send|Chat|Message|Stream|Event|Orchestrator/i.test(c.path)) {
    continue;
  }
  console.log('---', c.status, c.path);
  console.log('req', (c.reqBody || '').slice(0, 800));
  console.log('res', (c.resBody || '').slice(0, 800));
}
