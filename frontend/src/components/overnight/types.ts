export type OvernightQueueState = "prepared" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "blocked";
export type OvernightJobState = "pending" | "starting" | "active" | "completed" | "failed" | "cancelled" | "interrupted" | "blocked";

export interface OvernightJob {
  job_id: string;
  index: number;
  name: string;
  state: OvernightJobState;
  target_rgb: [number, number, number];
  optimizer_seed: number;
  color_setup: Record<string, unknown>;
  campaign_id?: string | number | null;
  created_at?: string | number | null;
  started_at?: string | number | null;
  completed_at?: string | number | null;
  best_objective?: number | null;
  best_parameters?: Record<string, unknown> | null;
  trials_completed?: number | null;
  stop_reason?: string | null;
  error?: string | null;
}

export interface OvernightQueueRecord {
  queue_id: string;
  name: string;
  state: OvernightQueueState;
  created_at: string | number;
  updated_at: string | number;
  started_at?: string | number | null;
  completed_at?: string | number | null;
  current_job_index?: number | null;
  stop_reason?: string | null;
  error?: string | null;
  cancel_requested: boolean;
  resource_summary: {
    campaign_count: number;
    sample_count: number;
    tip_count: number;
    total_volume_ul: number;
    candidate_wells: string[];
    fluid_state_id?: string | number | null;
    gantry_file: string;
    deck_file: string;
  };
  jobs: OvernightJob[];
  events: { sequence: number; timestamp: string | number; kind: string; job_index?: number | null; campaign_id?: string | number | null; message: string; data?: Record<string, unknown> | null }[];
}

export interface OvernightColorSetup {
  gantry_file: string;
  deck_file: string;
  source_protocol_file: string;
  batch_size: 3;
  target_mode: "rgb";
  target_rgb: [number, number, number];
  target_well: string;
  reference_origin: "user_selected_srgb";
  red_source: string;
  yellow_source: string;
  blue_source: string;
  diluent_source: string | null;
  component_min_ul: 25;
  component_max_ul: 100;
  total_volume_ul: 150;
  candidate_wells: string[];
  camera_instrument: string;
  roi_fraction: number;
  image_height: number | null;
  photo_position: [number, number, number] | null;
  fluid_state_id: number;
  mock_mode: false;
}

export interface OvernightQueuePrepare {
  name: string;
  jobs: {
    name: string;
    target_rgb: [number, number, number];
    optimizer_seed: number;
    color_setup: OvernightColorSetup;
  }[];
}
