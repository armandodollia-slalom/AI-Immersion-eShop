// Run-wide switches that travel through the environment to every process a pipeline run starts (the
// implement workers, the stages they call, the agents and their usage records):
//   PIPELINE_DELIVERY       "epic" or "story": how `implement run` delivers the stories (tags records)
//   PIPELINE_EXPERIMENT_ID  set by `pipeline experiment run` (tags records)
//   PIPELINE_EXPERIMENT_ARM the arm (<mode>-<n>) of the experiment (tags records)
//   PIPELINE_BOARD=0|off    no board reads or writes (experiments)
//   PIPELINE_LESSONS=off    no lessons or factory retro writes (experiments)
//   PIPELINE_NO_PR=1        never push or open a pull request (experiments)
// See docs/ai-pipeline/experiments.md.

const OFF = new Set(['0', 'off', 'false', 'no']);

// The fields every metrics record of this run carries: `delivery` once a run sets it, and
// `experiment_id` inside an experiment. Empty outside both, so ordinary records are unchanged.
export function runTags(env = process.env) {
  const tags = {};
  if (env.PIPELINE_DELIVERY) tags.delivery = env.PIPELINE_DELIVERY;
  if (env.PIPELINE_EXPERIMENT_ID) tags.experiment_id = env.PIPELINE_EXPERIMENT_ID;
  if (env.PIPELINE_EXPERIMENT_ARM) tags.experiment_arm = env.PIPELINE_EXPERIMENT_ARM;
  return tags;
}

export const boardDisabled = (env = process.env) => OFF.has(String(env.PIPELINE_BOARD ?? '').toLowerCase());
export const lessonsDisabled = (env = process.env) => OFF.has(String(env.PIPELINE_LESSONS ?? '').toLowerCase());
export const prsDisabled = (env = process.env) => env.PIPELINE_NO_PR === '1';
