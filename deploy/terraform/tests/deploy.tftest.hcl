# `terraform test` with a mocked OCI provider (spec 013, AC-7 and AC-8): plans only, against
# mock data, with no credentials and no call to Oracle Cloud.

mock_provider "oci" {
  mock_data "oci_identity_availability_domains" {
    defaults = {
      availability_domains = [
        { name = "Uocm:SA-SAOPAULO-1-AD-1", id = "ad-1", compartment_id = "ocid1.tenancy.oc1..test" },
      ]
    }
  }

  mock_data "oci_core_images" {
    defaults = {
      images = [{ id = "ocid1.image.oc1.sa-saopaulo-1.test" }]
    }
  }
}

variables {
  region           = "sa-saopaulo-1"
  compartment_ocid = "ocid1.tenancy.oc1..test"
  operator_cidr    = "203.0.113.10/32"
  ssh_public_key   = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyOnly test@ci"
}

run "defaults_stay_within_always_free" {
  command = plan

  assert {
    condition     = oci_core_instance.demo.shape == "VM.Standard.A1.Flex"
    error_message = "the VM must use the Ampere A1 flexible shape"
  }

  assert {
    condition     = oci_core_instance.demo.shape_config[0].ocpus == 2 && oci_core_instance.demo.shape_config[0].memory_in_gbs == 12
    error_message = "defaults must be 2 OCPUs and 12 GB (Always Free Ampere A1 allowance)"
  }

  assert {
    condition     = oci_core_instance.demo.source_details[0].boot_volume_size_in_gbs == 50
    error_message = "the boot volume must default to 50 GB"
  }
}

run "only_http_https_and_operator_ssh_are_open" {
  command = plan

  assert {
    condition     = length(oci_core_security_list.public.ingress_security_rules) == 3
    error_message = "exactly three ingress rules are allowed"
  }

  assert {
    condition = toset([
      for rule in oci_core_security_list.public.ingress_security_rules :
      "${rule.protocol}/${rule.tcp_options[0].min}-${rule.tcp_options[0].max} from ${rule.source}"
      ]) == toset([
      "6/80-80 from 0.0.0.0/0",
      "6/443-443 from 0.0.0.0/0",
      "6/22-22 from 203.0.113.10/32",
    ])
    error_message = "ingress must be TCP 80/443 from anywhere and TCP 22 from operator_cidr only"
  }

  assert {
    condition     = oci_core_route_table.public.route_rules[0].destination == "0.0.0.0/0"
    error_message = "the public subnet routes to the internet gateway"
  }
}

run "metadata_holds_no_secrets_and_fits" {
  command = plan

  assert {
    condition     = toset(keys(oci_core_instance.demo.metadata)) == toset(["ssh_authorized_keys", "user_data"])
    error_message = "instance metadata must hold only the public SSH key and cloud-init"
  }

  assert {
    # Oracle: metadata and extendedMetadata together are limited to 32,000 bytes.
    condition     = length(oci_core_instance.demo.metadata["user_data"]) + length(oci_core_instance.demo.metadata["ssh_authorized_keys"]) < 32000
    error_message = "instance metadata must stay under 32,000 bytes"
  }

  assert {
    condition     = startswith(base64decode(oci_core_instance.demo.metadata["user_data"]), "#cloud-config\n")
    error_message = "user_data must be a cloud-config document"
  }

  assert {
    condition     = strcontains(base64decode(oci_core_instance.demo.metadata["user_data"]), "/usr/local/bin/switchyard-fetch 0.1.0")
    error_message = "cloud-init must install the compose bundle of switchyard_version"
  }
}

run "rejects_ssh_from_anywhere" {
  command = plan

  variables {
    operator_cidr = "0.0.0.0/0"
  }

  expect_failures = [var.operator_cidr]
}

run "rejects_a_very_wide_operator_cidr" {
  command = plan

  variables {
    operator_cidr = "0.0.0.0/1"
  }

  expect_failures = [var.operator_cidr]
}

run "rejects_a_malformed_operator_cidr" {
  command = plan

  variables {
    operator_cidr = "my-laptop"
  }

  expect_failures = [var.operator_cidr]
}

run "rejects_more_than_the_always_free_ocpus" {
  command = plan

  variables {
    ocpus = 4
  }

  expect_failures = [var.ocpus]
}

run "rejects_more_than_the_always_free_memory" {
  command = plan

  variables {
    memory_in_gbs = 24
  }

  expect_failures = [var.memory_in_gbs]
}

run "rejects_a_boot_volume_beyond_the_free_storage" {
  command = plan

  variables {
    boot_volume_size_in_gbs = 250
  }

  expect_failures = [var.boot_volume_size_in_gbs]
}
