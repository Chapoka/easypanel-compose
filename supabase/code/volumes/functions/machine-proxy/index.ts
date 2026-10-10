// Edge Function: machine-proxy
// Repassa as chamadas do frontend para a API de Integração v2 da Machine,
// injetando as credenciais (api-key + Basic auth) de forma segura no servidor.
//
// Segredos necessários (supabase secrets set):
//   MACHINE_API_KEY      -> sua chave de API
//   MACHINE_USERNAME     -> usuário de integração
//   MACHINE_PASSWORD     -> senha do usuário
//   MACHINE_BASE_URL     -> opcional. Produção: https://api.taximachine.com.br/api/v2/integracao
//                           Homologação:  https://api-vendas.taximachine.com.br/api/v2/integracao
//
// Contrato:
//   POST /functions/v1/machine-proxy
//   Authorization: Bearer <supabase user JWT>
//   Body: { path: "corridas/consultar", method: "POST", query?: {...}, body?: {...} }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PROD_BASE = 'https://api.taximachine.com.br/api/v2/integracao'
const HML_BASE = 'https://api-vendas.taximachine.com.br/api/v2/integracao'

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json(405, { success: false, errors: ['Método não permitido.'] })
  }

  // Exige usuário autenticado no Supabase (verify_jwt também garante isso no gateway)
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    return json(401, { success: false, errors: ['Não autenticado.'] })
  }

  const apiKey = Deno.env.get('MACHINE_API_KEY')
  const username = Deno.env.get('MACHINE_USERNAME')
  const password = Deno.env.get('MACHINE_PASSWORD')

  if (!apiKey || !username || !password) {
    return json(500, {
      success: false,
      errors: [
        'Credenciais da API Machine não configuradas. Defina os secrets MACHINE_API_KEY, MACHINE_USERNAME e MACHINE_PASSWORD.',
      ],
    })
  }

  let payload: {
    path?: string
    method?: string
    query?: Record<string, unknown>
    body?: unknown
  }
  try {
    payload = await req.json()
  } catch {
    return json(400, { success: false, errors: ['Body JSON inválido.'] })
  }

  const path = (payload.path ?? '').replace(/^\/+/, '')
  if (!path) {
    return json(400, { success: false, errors: ['Parâmetro "path" é obrigatório.'] })
  }

  // Bloqueia qualquer tentativa de sair do prefixo da API de integração
  if (path.includes('..') || path.startsWith('http')) {
    return json(400, { success: false, errors: ['Caminho inválido.'] })
  }

  const env = (Deno.env.get('MACHINE_ENV') ?? 'producao').toLowerCase()
  const baseUrl = Deno.env.get('MACHINE_BASE_URL') || (env.includes('homolog') ? HML_BASE : PROD_BASE)

  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path}`)
  if (payload.query) {
    for (const [key, value] of Object.entries(payload.query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const method = (payload.method ?? 'GET').toUpperCase()

  try {
    const upstream = await fetch(url.toString(), {
      method,
      headers: {
        'api-key': apiKey,
        Authorization: `Basic ${base64(`${username}:${password}`)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload.body ?? {}),
    })

    const text = await upstream.text()
    // Repassa o status (200, 400, 403, 429...) e os headers de rate limit
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    }
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-total-period', 'retry-after']) {
      const v = upstream.headers.get(h)
      if (v) headers[h] = v
    }

    return new Response(text, { status: upstream.status, headers })
  } catch (err) {
    return json(502, {
      success: false,
      errors: [`Falha ao contatar a API Machine: ${String(err)}`],
    })
  }
})
