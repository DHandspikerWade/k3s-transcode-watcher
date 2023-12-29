const k8s = require('@kubernetes/client-node');
const mqtt = require("mqtt");
let client = null;

if (process.env.MQTT_BROKER) {
    client = mqtt.connect("mqtt://" + process.env.MQTT_BROKER);
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sContext = kc.getContextObject(kc.getCurrentContext());

const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);

console.log('Using found context: ', JSON.stringify(k8sContext));

async function getHandBrakeStatus(pod) {
    const updates = [];

    // Grab up to 50 of the last lines within the last 500 seconds
    const response = await k8sCoreApi.readNamespacedPodLog(pod.metadata.name, pod.metadata.namespace,undefined,false,undefined,undefined,undefined,undefined,500, 50);
    
    if (response.body) {
        let logChunks = response.body.split('Progress: {');
        logChunks.forEach((possiblelob) => {
            try {
                let data = JSON.parse('{' + possiblelob);
                updates.push(data);
            } catch (e) {
                // incomplete JSON, ignore it
            }
        });
    }

    return updates.length ? updates.pop() : null;
}

async function getJobs() {
    const response = await k8sBatchApi.listNamespacedJob(k8sContext.namespace || 'default', 'false', undefined, undefined,undefined, 'transcode_hash');

    const jobs = [];
    response.body.items.forEach(function (job) {
        if (!('transcode_hash' in job.metadata.labels)) {
            console.error('Got job without transcode_hash...how?')
            return;
        }

        jobs.push(job);
    });
    return jobs;
}

async function getPodFromJob(job) {
    const response = await k8sCoreApi.listNamespacedPod(
        k8sContext.namespace || 'default', 
        'false', 
        null, 
        null, 
        null, 
        'batch.kubernetes.io/controller-uid=' + job.metadata.uid,
        5
    );

    if (response.body.items.length > 0) {
        return response.body.items[0];
    }

    return null;
}

function logStatus(processDetail) {

}

function publishStatus(running, pending, totaljobs, items) {
    if (client) {
        items.sort((a, b) => {
            if (a.runtime < b.runtime) return 1;
            if (a.runtime > b.runtime) return -1;
            return 0;
        })

        client.publish('transcodes', JSON.stringify({
            totaljobs,
            running,
            pending,
            totaljobs,
            longestRunning: items[0],
            items
        }));
    }
}

const main = async () => {
    let running = 0,
        pending = 0,
        totaljobs = 0,
        processData = [];

    const waitingFor = [];

    const jobs = await getJobs();
    totaljobs = jobs.length;

    jobs.forEach(function(job) {
        
        waitingFor[waitingFor.length] = new Promise(async (resolve, reject) => {
            const pod = await getPodFromJob(job);
            const processDetail = {
                jobName: job.metadata.name,
                podStatus: null,
                runtime: 0, // TODO: should this be pod or handbrake runtime?
                filename: null,
                handbrakeState: 'UNKNOWN',
                handbrakeRate: 0,
                handbrakeAvgRate: 0,
                handbrakeProgress: 0,
                eta: -1
            };

            if (job.spec.template.spec.containers[0].env) {
                job.spec.template.spec.containers[0].env.forEach((env) => {
                    if (env.name == 'OUTPUT_FILE') {
                        processDetail.filename = env.value + '';
                    }
                });
            }
            
            if (pod) {
                processDetail.podStatus = pod.status.phase;

                switch (pod.status.phase) {
                    case 'Running':
                        running++;
                        break;
                    case 'Pending':
                        pending++;
                        break;
                }

                pod.status.conditions.forEach((condition) => {
                    if (condition.type === 'ContainersReady' && condition.status === 'True') {
                        processDetail.runtime = Date.now() - Date.parse(condition.lastTransitionTime);
                    }
                });

                const handbrakeOutput = await getHandBrakeStatus(pod);
                if (handbrakeOutput) {
                    processDetail.handbrakeState = handbrakeOutput.State;

                    // Check the state to prevent artificial progress spikes during scanning
                    if (handbrakeOutput.State === 'WORKING' && handbrakeOutput.Working) {
                        processDetail.eta = handbrakeOutput.Working.ETASeconds;

                        // Round to two decimal point
                        processDetail.handbrakeRate = Math.round(handbrakeOutput.Working.Rate * 100) / 100;
                        processDetail.handbrakeAvgRate = Math.round(handbrakeOutput.Working.RateAvg * 100) / 100;
                        // Round to single decimal point
                        processDetail.handbrakeProgress = Math.round(handbrakeOutput.Working.Progress * 1000) / 10;
                    }
                }
            }

            processData.push(processDetail);
            logStatus(processDetail);
            resolve(processDetail);
        });

    });

    Promise.all(waitingFor).then(() => {
        publishStatus(running, pending, totaljobs, processData);
    });
};

const intervalId = setInterval(main, 30e3);


process.on( 'SIGINT', function() {
    console.log('Recieved SIGINT');
    clearInterval(intervalId);
    if (client) {
        client.end();
    }
  })

main();
