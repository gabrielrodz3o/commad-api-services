// Image models are independent of the company's chat model.
// GPT Image 1 was retired on 2026-10-23.
// https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
export const IMAGE_MODEL = 'gpt-image-2.5-sunburst'

// Shared by generations and edits. Current models do not require the legacy
// input_fidelity parameter. Keep PNG explicit for the catalogue's MIME contract.
export const imageRequestOptions = {
  model: IMAGE_MODEL,
  size: '1024x1024',
  quality: 'medium',
  output_format: 'png',
  n: 1,
} as const
