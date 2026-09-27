output "vpc_id" {
  value = aws_vpc.dev.id
}

output "subnet_ids" {
  value = aws_subnet.public[*].id
}

output "operator_policy_arn" {
  description = "Attach to the IAM user or role behind each developer's AWS_PROFILE."
  value       = aws_iam_policy.operator.arn
}

output "env" {
  description = "Paste into a project's .env (terraform output -raw env)."
  value       = <<-EOT
    AWS_PROFILE=${var.aws_profile}
    CLOUD_REGION=${var.region}
    CLOUD_SUBNET=${aws_subnet.public[0].id}
    CLOUD_SECURITY_GROUP=${aws_security_group.dev.id}
    CLOUD_KEY_NAME=${aws_key_pair.dev.key_name}
    CLOUD_SCHEDULER_ROLE_ARN=${aws_iam_role.scheduler.arn}
  EOT
}
