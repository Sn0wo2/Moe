import { Context, Schema } from 'koishi'
import { QQ, type QQBot } from '@satorijs/adapter-qq'
import {} from '@koishijs/plugin-server'

export const name = 'meo'
export const inject = { required: ['server'], optional: ['database'] }

export interface Config {
  path: string
  channels: Target[]
}

interface Target {
  platform: string
  selfId: string
  channelId: string
  mode: 'private' | 'group'
}

type Bot = Context['bots'][number]

const targetSchema = Schema.object({
  platform: Schema.string().description('平台'),
  selfId: Schema.string().description('机器人 ID'),
  channelId: Schema.string().description('频道/用户 ID'),
  mode: Schema.union(['private', 'group'] as const).description('发送模式'),
})

function createMarkdownPayload(content: string): QQ.Message.Request {
  return {
    msg_type: QQ.Message.Type.MARKDOWN,
    markdown: {
      content,
    },
  }
}

async function sendTargetMessage(bot: Bot, channelId: string, mode: Target['mode'], message: string) {
  if (bot.platform === 'qq') {
    const qqBot = bot as unknown as QQBot
    const payload = createMarkdownPayload(message)
    return mode === 'private'
      ? qqBot.internal.sendPrivateMessage(channelId, payload)
      : qqBot.internal.sendMessage(channelId, payload)
  }

  return mode === 'private'
    ? bot.sendPrivateMessage(channelId, message)
    : bot.sendMessage(channelId, message)
}
Schema.object({
  path: Schema.string().default('/meo/webhook').description('WebHook 接收路径'),
  channels: Schema.array(targetSchema).default([]).description('目标列表'),
});
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('meo')

  logger.info('plugin started', {
    path: config.path,
    targets: config.channels.length,
    hasDatabase: !!ctx.database,
    bots: ctx.bots.map((bot) => ({
      platform: bot.platform,
      selfId: bot.selfId,
      status: bot.status,
      active: bot.isActive,
    })),
  })

  ctx.server.post(config.path, async (koaCtx) => {
    const body = koaCtx.request.body as any
    const { message } = body

    logger.info('webhook received', {
      ip: koaCtx.ip,
      method: koaCtx.method,
      path: koaCtx.path,
      contentType: koaCtx.get('content-type'),
      body,
    })

    if (!message) {
      logger.warn('webhook rejected: missing message field')
      koaCtx.status = 400
      koaCtx.body = { error: 'missing message' }
      return
    }

    const results: { target: string, ok: boolean, mode: 'group' | 'private' | 'unknown' }[] = []
    for (const { platform, selfId, channelId, mode } of config.channels) {
      const targetId = `${platform}:${selfId}:${channelId}`
      const destinationId = channelId || selfId
      const bot = ctx.bots[`${platform}:${selfId}`]

      if (!bot) {
        results.push({ target: targetId, ok: false, mode: 'unknown' })
        logger.warn('bot not found', { target: targetId })
        continue
      }

    logger.info('sending', {
      target: targetId,
      platform,
      selfId,
        channelId,
        mode,
        botStatus: bot.status,
        botActive: bot.isActive,
    })

    try {
      logger.info('send mode', { target: targetId, mode })
      await sendTargetMessage(bot, destinationId, mode, message)
      results.push({ target: targetId, ok: true, mode })
    } catch (e) {
      results.push({ target: targetId, ok: false, mode })
        logger.warn('send failed', {
          target: targetId,
          mode,
          error: e,
          botStatus: bot.status,
          botActive: bot.isActive,
        })
      }
    }

    logger.info('webhook done', {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    })
    koaCtx.status = 200
    koaCtx.body = { status: 'ok', results }
  })
}
