import type { Register } from 'claude-code'

import { registerProbe } from './probe'

export const register: Register = (on, options) => {
  registerProbe(on, { probe: options.probe === true })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mc',
      description: 'Open Mission Control',
    })
    return next(e)
  })

  on('command.run', { command: 'mc' }, async () => {
    return { text: 'Mission Control: not built yet.' }
  })
}
