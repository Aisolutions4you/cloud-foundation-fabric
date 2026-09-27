/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

variable "app_config" {
  description = "Non-secret app environment (BUSINESS_NAME, PUBLIC_BASE_URL, BOOKING_URL, LLM_PROVIDER_ORDER, OPENROUTER_MODEL, GHL_LOCATION_ID, GHL_PIPELINE_ID, GHL_STAGE_*, OUTBOUND_WEBHOOK_URLS...)."
  type        = map(string)
  default     = {}
  nullable    = false
}

variable "deletion_protection" {
  description = "Protect the Cloud Run service and data bucket from accidental deletion."
  type        = bool
  default     = true
  nullable    = false
}

variable "image" {
  description = "Container image. Leave null on first apply to deploy a placeholder, then push the app image to the created registry and set it here."
  type        = string
  default     = null
}

variable "name" {
  description = "Base name for all resources."
  type        = string
  default     = "lead-intake"
  nullable    = false
}

variable "prefix" {
  description = "Optional prefix for globally unique names (bucket)."
  type        = string
  default     = null
}

variable "project_id" {
  description = "Project id where the platform is deployed."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry and the data bucket."
  type        = string
  default     = "us-central1"
  nullable    = false
}

variable "secrets" {
  description = "Secret env vars (e.g. OPENROUTER_API_KEY, GHL_API_KEY, WEBHOOK_SIGNING_SECRET, INBOUND_WEBHOOK_SECRET, TWIN_WEBHOOK_URL, ADMIN_TOKEN). Stored in Secret Manager as write-only versions, never in state."
  type        = map(string)
  default     = {}
  nullable    = false
  sensitive   = true
}

variable "secrets_version" {
  description = "Bump to push new values for all secrets (write-only secret versions are only re-sent when this changes)."
  type        = number
  default     = 1
  nullable    = false
}
