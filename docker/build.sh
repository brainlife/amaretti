docker build -t soichih/sca-wf ..
if [ ! $? -eq 0 ]; then
    echo "failed to build"
    exit
fi
docker tag soichih/sca-wf soichih/sca-wf:1.0.0
docker push soichih/sca-wf
