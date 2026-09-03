/* dsh-file-attach — strict host wire definitions.
 *
 * Hand-written in the official typert-loader manifest format (same shape as
 * the generated artifacts). The typert-loader registers this manifest into
 * the host typert registry on mount, so every DSH version recognizes the
 * attachUpload endpoints — including builds without the SRC discovery
 * fallback. Do not edit without re-checking the loader validation rules.
 */

import { z } from 'zod'

const PKG = 'dsh-file-attach'

const zUnknown = z.unknown()
const zString = z.string()
const zNumber = z.number()

const jsonResult = (method) => ({
  mode: 'strict',
  typeSymbol: `${PKG}#${method}#result`,
  schema: zUnknown,
})

const strParam = (method, name) => ({
  name,
  wire: name,
  source: 'json',
  codec: { mode: 'strict', typeSymbol: `${PKG}#${method}#${name}`, schema: zString },
})

const numParam = (method, name) => ({
  name,
  wire: name,
  source: 'json',
  codec: { mode: 'strict', typeSymbol: `${PKG}#${method}#${name}`, schema: zNumber },
})

const inv = (method, parameters) => ({
  id: `${PKG}#attachUpload/${method}`,
  service: 'attachUpload',
  namespace: 'attachUpload',
  method,
  invocation: { kind: 'direct' },
  parameters,
  result: jsonResult(method),
})

export const TYPERT = {
  package: PKG,
  face: 'host',
  schemas: [],
  invocations: [
    inv('beginUpload', [
      strParam('beginUpload', 'sessionId'),
      strParam('beginUpload', 'name'),
      numParam('beginUpload', 'size'),
    ]),
    inv('uploadChunk', [
      strParam('uploadChunk', 'uploadId'),
      numParam('uploadChunk', 'index'),
      strParam('uploadChunk', 'data'),
    ]),
    inv('finishUpload', [strParam('finishUpload', 'uploadId')]),
    inv('abortUpload', [strParam('abortUpload', 'uploadId')]),
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
