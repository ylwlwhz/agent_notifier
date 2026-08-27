/**
 * 环境变量配置管理模块
 * 统一处理所有环境变量的加载和配置
 */

const fs = require('fs');
const path = require('path');

/**
 * 环境变量配置类
 */
class EnvConfig {
    constructor() {
        this.loadEnvironmentVariables();
    }

    /**
     * 加载环境变量
     * 根据脚本所在位置加载 .env 文件
     */
    loadEnvironmentVariables() {
        try {
            // __dirname = src/lib，.env 在仓库根
            const envPath = path.join(__dirname, '..', '..', '.env');

            if (fs.existsSync(envPath)) {
                require('dotenv').config({ path: envPath });
                console.log('✅ 环境变量加载成功');
            } else {
                console.log('⚠️  .env 文件不存在，使用系统环境变量');
                require('dotenv').config();
            }
        } catch (error) {
            console.log('❌ 环境变量加载失败:', error.message);
        }

        // 飞书/Lark 是国内服务，而本机 http_proxy 常指向境外代理；
        // 若不放行，Lark SDK(axios) 会把飞书 API 也走代理并被 403 拦截，导致卡片发不出。
        // 这里统一把飞书域名追加进 no_proxy，确保任何启动方式(含 tmux 内继承代理)都直连飞书。
        //
        // 例外：部分机器（如公司内网服务器）出网**必须**走代理，飞书直连反而不通 ——
        // 症状是发卡时报 `Cannot destructure property 'tenant_access_token'`（连不上鉴权接口）。
        // 这类机器在 .env 设 FEISHU_FORCE_PROXY=1，跳过 no_proxy 注入，让飞书也走代理。
        if (!this.isFeishuForceProxy()) {
            this.ensureFeishuNoProxy();
        }
    }

    /** 是否强制让飞书走代理（本机直连不通、必须经代理出网的场景） */
    isFeishuForceProxy() {
        const v = (process.env.FEISHU_FORCE_PROXY || '').trim().toLowerCase();
        return v === '1' || v === 'true' || v === 'yes';
    }

    /** 确保飞书/Lark 域名绕过 http(s)_proxy，幂等合并已有 no_proxy */
    ensureFeishuNoProxy() {
        const feishuHosts = ['open.feishu.cn', 'feishu.cn', 'open.larksuite.com', 'larksuite.com'];
        for (const key of ['no_proxy', 'NO_PROXY']) {
            const set = new Set(
                (process.env[key] || '').split(',').map((s) => s.trim()).filter(Boolean)
            );
            feishuHosts.forEach((h) => set.add(h));
            process.env[key] = Array.from(set).join(',');
        }
    }

    /**
     * 获取飞书自建应用配置（双向通信）
     */
    getFeishuAppConfig() {
        return {
            app_id: process.env.FEISHU_APP_ID || '',
            app_secret: process.env.FEISHU_APP_SECRET || '',
            chat_id: process.env.FEISHU_CHAT_ID || '',
            enabled: !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
        };
    }

    /**
     * 获取声音通知配置
     */
    getSoundConfig() {
        return {
            enabled: process.env.SOUND_ENABLED !== 'false',
            backup: true
        };
    }

    /**
     * 获取通用通知配置
     */
    getNotificationConfig() {
        return {
            enabled: process.env.NOTIFICATION_ENABLED !== 'false'
        };
    }

    /**
     * 获取所有配置
     */
    getAllConfig() {
        return {
            feishu_app: this.getFeishuAppConfig(),
            sound: this.getSoundConfig(),
            notification: this.getNotificationConfig()
        };
    }
}

// 导出单例实例
const envConfig = new EnvConfig();

module.exports = {
    EnvConfig,
    envConfig
};