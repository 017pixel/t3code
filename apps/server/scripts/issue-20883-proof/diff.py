import sys
from PIL import Image, ImageChops

before, after, output = sys.argv[1:]
a, b = (Image.open(path).convert("RGB") for path in (before, after))
assert a.size == b.size, (a.size, b.size)
delta = ImageChops.difference(a, b)
delta.point(lambda value: min(255, value * 16)).save(output + "-diff0.png")
maximum = ImageChops.lighter(ImageChops.lighter(*delta.split()[:2]), delta.split()[2])
mask = maximum.point(lambda value: 255 if value > 8 else 0)
Image.composite(Image.new("RGB", a.size, "#ff00ff"), Image.new("RGB", a.size, "black"), mask).save(output + "-diff8.png")
print({"pixels_any_delta": sum(value > 0 for value in maximum.getdata()), "pixels_above_8": sum(value > 8 for value in maximum.getdata()), "size": a.size})
