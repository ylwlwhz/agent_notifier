'use strict';

/**
 * 飞书出网路径的两种机器：
 *   - 默认（本机/多数环境）：http_proxy 指向境外代理，飞书必须【绕开】它直连，
 *     否则 Lark SDK(axios) 会被 403 拦掉，卡片发不出去。
 *   - 例外（公司内网服务器）：出网【必须】经代理，飞书直连不通 —— 症状是发卡时报
 *     `Cannot destructure property 'tenant_access_token'`（连不上鉴权接口）。
 *
 * 这两条互斥，靠 FEISHU_FORCE_PROXY 切换。这里只测这两个方法本身，不走构造函数
 * ——那会 dotenv 读进仓库真实 .env，用例就不再自洽了。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { EnvConfig } = require('../../src/lib/env-config');

/** 借用原型方法，避免 new 触发 dotenv 加载真实 .env */
const config = Object.create(EnvConfig.prototype);

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('ensureFeishuNoProxy：追加飞书域名且保留既有条目（幂等）', () => {
    withEnv({ no_proxy: 'localhost', NO_PROXY: 'localhost' }, () => {
        config.ensureFeishuNoProxy();
        config.ensureFeishuNoProxy(); // 幂等：再来一次不该重复堆积

        assert.match(process.env.no_proxy, /open\.feishu\.cn/);
        assert.match(process.env.no_proxy, /localhost/);
        assert.equal(process.env.no_proxy.split(',').filter((h) => h === 'open.feishu.cn').length, 1);
        assert.match(process.env.NO_PROXY, /open\.larksuite\.com/);
    });
});

test('isFeishuForceProxy：只认 1/true/yes，其余一律按默认（直连）处理', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
        withEnv({ FEISHU_FORCE_PROXY: value }, () => {
            assert.equal(config.isFeishuForceProxy(), true, value);
        });
    }
    for (const value of ['0', 'false', 'no', '', undefined]) {
        withEnv({ FEISHU_FORCE_PROXY: value }, () => {
            assert.equal(config.isFeishuForceProxy(), false, String(value));
        });
    }
});
