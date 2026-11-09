import z from '@deepseek-ai/schemastery'
import { createProgramStore } from './store.js'
import { createPtcRuntimeBridge } from './runtime.js'
import { createPtcSdkTool } from './tool.js'

export const name = 'ptc-sdk-forge'
export const inject = ['tools', 'ptcRuntime', 'systemPrompt']

export const Config = z.object({
  root: z.string().default('').description('SDK artifact library directory. Empty uses the DSH-home plugin directory.'),
  maxParallelSubCalls: z.natural().min(1).max(64).default(10),
  maxResultChars: z.natural().min(1024).max(1_000_000).default(50_000),
  discoverLimit: z.natural().min(1).max(500).default(100),
})

async function importHostModule(ctx, specifier) {
  if (typeof ctx.loader?.internal?.import === 'function') {
    return ctx.loader.internal.import(specifier, ctx.baseUrl, {})
  }
  return import(specifier)
}

export const apply = async (ctx, config) => {
  const [{ defineTool }, { dshHomePath }] = await Promise.all([
    importHostModule(ctx, '@deepseek-ai/dsh-tools'),
    importHostModule(ctx, '@deepseek-ai/dsh-home-paths'),
  ])
  const root = config.root.trim() || dshHomePath('ptc-sdk-forge')
  const store = createProgramStore({ root })
  const runtime = await createPtcRuntimeBridge(ctx, {
    maxParallelSubCalls: config.maxParallelSubCalls,
    maxResultChars: config.maxResultChars,
    discoverLimit: config.discoverLimit,
  })
  let unregister
  try {
    unregister = ctx.tools.register(createPtcSdkTool({ defineTool, store, runtime }))
  } catch (error) {
    await runtime.dispose()
    throw error
  }

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    try {
      unregister()
    } finally {
      await runtime.dispose()
    }
  }
}
