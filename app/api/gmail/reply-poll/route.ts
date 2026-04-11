import { pollAllCustomerReplies } from '@/src/winback/lib/reply'

export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const result = await pollAllCustomerReplies()
  return Response.json(result)
}
