tag=1.2.4

set -e
set -x

docker build -t brainlife/amaretti ..
docker tag brainlife/amaretti brainlife/amaretti:$tag
docker push brainlife/amaretti:$tag
