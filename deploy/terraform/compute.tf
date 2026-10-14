data "oci_identity_availability_domains" "all" {
  compartment_id = var.compartment_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = local.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  shape    = "VM.Standard.A1.Flex"
  image_id = var.image_ocid != null ? var.image_ocid : data.oci_core_images.ubuntu.images[0].id

  # The only template variable is the version: secrets never pass through Terraform (AC-9).
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    switchyard_version = var.switchyard_version
  })
}

resource "oci_core_instance" "demo" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.all.availability_domains[var.availability_domain_number - 1].name
  display_name        = "${var.name_prefix}-demo"
  shape               = local.shape

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    hostname_label   = "switchyard"
  }

  # Public SSH key and cloud-init only: no secret in instance metadata.
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(local.cloud_init)
  }

  lifecycle {
    # A newer Ubuntu image or an edited cloud-init must not replace the running VM (and its
    # data); upgrades happen on the VM (docs/deploy.md).
    ignore_changes = [source_details[0].source_id, metadata["user_data"]]
  }
}
