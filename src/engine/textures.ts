/** Loads an image into an rgba8 texture with a full mip chain (resized on the CPU per level). */
export async function loadTexture(device: GPUDevice, url: string, isNormalMap = false): Promise<GPUTexture> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`)
  const blob = await response.blob()
  const options: ImageBitmapOptions = {
    colorSpaceConversion: isNormalMap ? 'none' : 'default',
    premultiplyAlpha: 'none',
  }
  const base = await createImageBitmap(blob, options)
  const levels = Math.floor(Math.log2(Math.max(base.width, base.height))) + 1
  const texture = device.createTexture({
    label: url,
    size: [base.width, base.height],
    format: 'rgba8unorm',
    mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const bitmaps: ImageBitmap[] = []
  for (let level = 0; level < levels; level++) {
    const width = Math.max(1, base.width >> level)
    const height = Math.max(1, base.height >> level)
    const bitmap =
      level === 0
        ? base
        : await createImageBitmap(blob, { ...options, resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, mipLevel: level }, [width, height])
    bitmaps.push(bitmap)
  }
  // The copy reads the bitmap asynchronously: closing it right away left the larger
  // mip levels empty in Chrome. Release them once the queue is done.
  await device.queue.onSubmittedWorkDone()
  for (const bitmap of bitmaps) bitmap.close()
  return texture
}
