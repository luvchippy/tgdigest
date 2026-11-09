/** 部署体检：打印每个站点真实拿到的第一条帖，用来核对接口是否仍然可用 */
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter } from './sources/index.mjs';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/sources.json'), 'utf8'));
const withinWindow = () => true;

for (const source of config.sources.filter((s) => s.enabled)) {
  console.log(`\n===== ${source.name} (${source.adapter}) =====`);
  const t0 = Date.now();
  try {
    const items = await getAdapter(source.adapter)(source, { withinWindow, needDetail: false });
    console.log(`[结果] ${items.length} 条  ${Date.now() - t0}ms`);
    if (items[0]) console.log('[样本] ' + JSON.stringify(items[0], null, 1).slice(0, 500));
  } catch (err) {
    console.log('[失败] ' + err.message);
  }
}
