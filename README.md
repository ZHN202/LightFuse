# LightFuse project page

Static project page for **LightFuse: Relightable Interactive Gaussian Scene Reconstruction via Multi-Scan Fusion and 2D Gaussian Ray Tracing**.

The page includes the [current manuscript](static/data/lightfuse-paper.pdf), [video demonstration](static/data/lightfuse-demo.mp4), and synthetic and captured scene comparisons. The preprint record is available on [arXiv](https://arxiv.org/abs/2608.29269).

## Interactive exhibits

The Bedroom comparison uses registered LightFuse renders from a single camera. The controls isolate a change in the chair’s pose or the environment lighting.

The object gallery features nine trained models from four synthetic scenes (Bedroom, Kitchen, Livingroom and Playroom). The Playroom toy car is selected by default. Selecting a thumbnail loads its model on demand. Each poster shows the interactive renderer’s default view. Links such as `?object=retro-computer#explore` open the selected model.

Each record represents one trained 2D Gaussian, with its center, two oriented tangent axes, opacity, base color, roughness and metallic value. The viewer projects the surfels, evaluates their Gaussian opacity in local coordinates and blends them in camera depth order. Image-based lighting lets visitors rotate the HDR environment around each object and inspect its learned materials.

The view-space normal channel orients each surfel’s geometric normal toward the eye, blends the directions with the same transmittance and opacity weights as the color pass, and normalizes the resulting vector per pixel. RGB encodes screen-right, screen-up and toward the camera. A shared link can open this view directly, for example `?object=plush-dog&surface=normal#explore`.

The browser sorts surfels by center depth and samples prefiltered environment maps. Overlapping, tilted surfels can have a different depth order along individual rays. The paper’s full-scene light transport and quantitative results use the offline ray tracer.

The full-scene relighting gallery shows Bedroom (camera 25), Kitchen (192) and Livingroom (68) under Bridge, Courtyard, Museum and Night. Each camera and layout stays fixed across the four environments. Frames were selected by comparing each prediction with its matching Blender reference at full resolution.

The full-scene renders use the 15,000-iteration checkpoint, one-bounce light transport and 32 samples per pixel. The lossless WebP images preserve the denoised renders and their Filmic display transform.

For a local preview including model loading, serve this directory with `python3 -m http.server 8000 --bind 127.0.0.1` and open [localhost:8000](http://localhost:8000/).
