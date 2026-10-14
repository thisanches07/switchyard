output "public_ip" {
  description = "Public IPv4 address of the demo VM."
  value       = oci_core_instance.demo.public_ip
}

output "ssh_command" {
  description = "SSH into the VM (from operator_cidr only)."
  value       = "ssh ubuntu@${oci_core_instance.demo.public_ip}"
}

output "demo_hostname" {
  description = "Default TLS hostname (wildcard DNS, no domain needed): SWITCHYARD_HOSTNAME in the env file."
  value       = "${replace(oci_core_instance.demo.public_ip, ".", "-")}.sslip.io"
}

output "tunnel_command" {
  description = "SSH tunnel to the admin API (localhost:8080) and Grafana (localhost:3000)."
  value       = "ssh -N -L 8080:172.30.0.10:8080 -L 3000:172.30.0.20:3000 ubuntu@${oci_core_instance.demo.public_ip}"
}
