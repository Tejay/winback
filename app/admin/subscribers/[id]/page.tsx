import { InspectorClient } from './inspector-client'

export default async function AdminSubscriberInspectorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <InspectorClient subscriberId={id} />
}
