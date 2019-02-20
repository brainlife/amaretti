tag=1.1.57

docker pull node:8
docker build -t brainlife/amaretti ..
if [ ! $? -eq 0 ]; then
    echo "failed to build"
    exit
fi
docker tag brainlife/amaretti brainlife/amaretti:$tag
docker push brainlife/amaretti:$tag
