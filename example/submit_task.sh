jwt=`cat ~/.sca/keys/cli.jwt`

curl \
    -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" \
    -X POST https://soichi7.ppa.iu.edu/api/sca/task -d '
{
    "instance_id": "570d1ef166a1e2fc1ef5a847",
    "service": "soichih/sca-service-tgzpipe",
    "config": {
        "input_dir": "/N/dc2/scratch/odiuser/SPIE_MasterCals_headers"
    }
}'
