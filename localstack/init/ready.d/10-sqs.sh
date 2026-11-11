#!/bin/bash
# Filas do enunciado (seção 10): wager-transactions.fifo e sua DLQ FIFO.
# Também cria wager-events (padrão) para os eventos da outbox.
# A consistência NÃO depende de FIFO: o banco garante as invariantes (ver ARCHITECTURE.md).
set -euo pipefail

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount do SQS (10) fica ACIMA do limite da aplicação (5): a aplicação marca FAILED e envia à DLQ
# antes; o redrive do SQS é só a rede de segurança caso o processo não consiga fazê-lo.
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"ContentBasedDeduplication\": \"false\",
  \"VisibilityTimeout\": \"60\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"
}" >/dev/null

awslocal sqs create-queue --queue-name wager-events >/dev/null
echo "SQS queues ready"
