import { CustomerDetailClient } from './customer-detail-client'

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <CustomerDetailClient customerId={id} />
}
